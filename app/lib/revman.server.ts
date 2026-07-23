// Revenue Management: booking-history import + storage.
//
// The hotelier connects their own Channex account by pasting their personal
// `user-api-key` on /admin/revenue. Unlike the onboard flow (key used once,
// discarded), revenue analytics need fresh OTA bookings, so the key IS kept —
// AES-GCM encrypted with a key derived from the session secret — and the cron
// re-imports new/changed bookings. Every imported booking room is exploded into
// one `rev_night` row per stay night; that per-night table is what all the
// analytics (KPIs, pace, forecast) query.
import { waitUntil } from "cloudflare:workers";

import { getConfig, getConfigKV, getDB } from "./config.server";
import { getChannexBookingsPage, getChannexRoomCount, listChannexProperties } from "./channex/pms.server";
import { bookingToNights, importLooksStalled } from "./revman";

function db(): D1Database {
  const d = getDB();
  if (!d) throw new Error("D1 database (binding DB) is not configured.");
  return d;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await db().batch([
    db().prepare(
      `CREATE TABLE IF NOT EXISTS rev_night (
        pid TEXT NOT NULL,
        booking_id TEXT NOT NULL,
        room_seq INTEGER NOT NULL,
        stay_date TEXT NOT NULL,
        rate_minor INTEGER NOT NULL,
        currency TEXT,
        booking_date TEXT NOT NULL,
        cancellation_date TEXT,
        is_cancelled INTEGER NOT NULL,
        lead_time INTEGER NOT NULL,
        los INTEGER NOT NULL,
        ota TEXT,
        adults INTEGER,
        children INTEGER,
        PRIMARY KEY (pid, booking_id, room_seq, stay_date)
      )`,
    ),
    db().prepare(`CREATE INDEX IF NOT EXISTS rev_night_stay ON rev_night (pid, stay_date)`),
    db().prepare(`CREATE INDEX IF NOT EXISTS rev_night_booked ON rev_night (pid, booking_date)`),
  ]);
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// Connection state (KV) + key encryption

export interface RevmanState {
  /** AES-GCM ciphertext + iv of the Channex user-api-key, base64. */
  keyCipher: string;
  keyIv: string;
  /** The Channex property whose bookings we import (usually = pid). */
  channexPropertyId: string;
  /** Occupancy denominator; from Channex room counts at connect, editable. */
  roomCount: number;
  connectedAt: string;
  lastImportAt?: string;
  lastImportCount?: number;
  importStatus: "idle" | "running" | "error";
  error?: string;
  /** Heartbeat while an import runs: bookings processed so far + timestamp.
   *  A "running" status with a stale heartbeat means the run died. */
  progressCount?: number;
  progressAt?: string;
  /** Resumable position of the running import — chunks pick up from here, and
   *  a stalled run resumes instead of restarting from page 1. */
  cursor?: {
    full: boolean;
    /** filter[inserted_at][gte] for incremental runs. */
    since?: string;
    page: number;
    imported: number;
    startedAt: string;
  };
  /** Safety rails for price suggestions (major units); Apply needs both. */
  minPrice?: number;
  maxPrice?: number;
}

/** State without the key material — safe shape for loaders/UI. */
export type RevmanPublicState = Omit<RevmanState, "keyCipher" | "keyIv">;

const stateKey = (pid: string) => `revman:${pid}`;

async function aesKey(): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`revman:${getConfig().sessionSecret}`));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

const toB64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function encryptApiKey(plain: string): Promise<{ keyCipher: string; keyIv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), new TextEncoder().encode(plain));
  return { keyCipher: toB64(cipher), keyIv: toB64(iv) };
}

/** Throws if the ciphertext can't be decrypted (e.g. the session secret was
 *  rotated) — surfaced as an error state so the owner reconnects. */
async function decryptApiKey(state: RevmanState): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(state.keyIv) },
    await aesKey(),
    fromB64(state.keyCipher),
  );
  return new TextDecoder().decode(plain);
}

async function readState(pid: string): Promise<RevmanState | undefined> {
  const raw = await getConfigKV()?.get(stateKey(pid));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as RevmanState;
  } catch {
    return undefined;
  }
}

async function writeState(pid: string, state: RevmanState): Promise<void> {
  await getConfigKV()?.put(stateKey(pid), JSON.stringify(state));
}

export async function getRevmanState(pid: string): Promise<RevmanPublicState | undefined> {
  const s = await readState(pid);
  if (!s) return undefined;
  const { keyCipher: _c, keyIv: _i, ...pub } = s;
  return pub;
}

export async function setRevmanRoomCount(pid: string, roomCount: number): Promise<void> {
  const s = await readState(pid);
  if (!s) return;
  await writeState(pid, { ...s, roomCount: Math.max(1, Math.round(roomCount)) });
}

export async function setRevmanPriceGuards(pid: string, minPrice: number, maxPrice: number): Promise<void> {
  const s = await readState(pid);
  if (!s) return;
  await writeState(pid, { ...s, minPrice, maxPrice });
}

/** Removes the stored key, every imported night, all demand snapshots and the
 *  price-base anchors. */
export async function disconnectRevman(pid: string): Promise<void> {
  await getConfigKV()?.delete(stateKey(pid));
  await ensureSchema();
  await db().prepare(`DELETE FROM rev_night WHERE pid = ?`).bind(pid).run();
  // Snapshot table is created lazily by the cron — may not exist yet.
  await db()
    .prepare(`DELETE FROM rev_demand_snapshot WHERE pid = ?`)
    .bind(pid)
    .run()
    .catch(() => {});
  const { wipePriceBases } = await import("./revman-analytics.server");
  await wipePriceBases(pid);
}

// ---------------------------------------------------------------------------
// Connect + import

export interface RevmanConnectResult {
  /** Set when the key is valid but doesn't own `pid` — the UI shows a picker. */
  pickFrom?: { id: string; title: string }[];
}

/** Validates the key, resolves which Channex property to import (defaults to
 *  the local pid — they're the same id for onboarded properties), stores the
 *  encrypted key, then runs the first full import. */
export async function connectRevman(
  pid: string,
  apiKey: string,
  channexPropertyId?: string,
): Promise<RevmanConnectResult> {
  const properties = await listChannexProperties(apiKey); // throws on bad key
  const targetId = channexPropertyId || pid;
  const target = properties.find((p) => p.id === targetId);
  if (!target) {
    return { pickFrom: properties.map((p) => ({ id: p.id, title: p.title })) };
  }
  const roomCount = await getChannexRoomCount(apiKey, target.id).catch(() => 0);
  const state: RevmanState = {
    ...(await encryptApiKey(apiKey)),
    channexPropertyId: target.id,
    roomCount: Math.max(1, roomCount),
    connectedAt: new Date().toISOString(),
    importStatus: "idle",
  };
  await writeState(pid, state);
  await importRevmanBookings(pid, { full: true });
  return {};
}

const MAX_PAGES = 500; // 50k bookings per run — runaway guard, logged when hit
// One D1 batch per ~90 statements, NOT per booking: a Worker invocation allows
// ~1,000 subrequests and every batch counts as one — per-booking batching was
// painfully slow on real properties (1,868 bookings = 1,868 round-trips) and
// close to the limit.
const BATCH_STMTS = 90;
// Pages processed per invocation. Background work started from a request is
// time-capped in production (~30s after the response), which killed large
// imports mid-run — a property "finished" at whatever page the cap hit and a
// restart began from page 1, so big properties could never complete. Each
// invocation now processes a small chunk, persists the cursor, and chains the
// next invocation (signed self-fetch, with the admin page's poll as backup).
const CHUNK_PAGES = 5;
/** Another chunk runner is considered active while its heartbeat is fresher
 *  than this — page heartbeats land every ~1-2s, so 12s ≈ dead chain. */
const CHUNK_ACTIVE_MS = 12_000;

async function completeImport(pid: string, state: RevmanState, cursor: NonNullable<RevmanState["cursor"]>): Promise<void> {
  await writeState(pid, {
    ...state,
    importStatus: "idle",
    error: undefined,
    lastImportAt: cursor.startedAt,
    lastImportCount: cursor.imported,
    progressCount: undefined,
    progressAt: undefined,
    cursor: undefined,
  });
  // Freeze today's total-demand picture (online + inferred offline) right
  // after the books changed — the daily snapshots are what let pace be
  // reconstructed for offline bookings we never see.
  try {
    const { snapshotDemand } = await import("./revman-analytics.server");
    await snapshotDemand(pid, new Date().toISOString().slice(0, 10), state.roomCount);
  } catch (err) {
    console.log(`[revman] demand snapshot failed for ${pid}: ${err}`);
  }
}

/** Process up to CHUNK_PAGES pages from the persisted cursor. Returns whether
 *  the import finished, has more to do, or wasn't running at all. */
async function runImportChunk(pid: string): Promise<"done" | "more" | "idle"> {
  await ensureSchema();
  let state = await readState(pid);
  if (!state || state.importStatus !== "running" || !state.cursor) return "idle";
  const apiKey = await decryptApiKey(state);

  let pending: D1PreparedStatement[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const stmts = pending;
    pending = [];
    await db().batch(stmts);
  };

  try {
    for (let i = 0; i < CHUNK_PAGES; i++) {
      const cursor: NonNullable<RevmanState["cursor"]> = state.cursor!;
      if (cursor.page > MAX_PAGES) {
        console.log(`[revman] ${pid}: hit the ${MAX_PAGES}-page import guard, stopping early`);
        await completeImport(pid, state, cursor);
        return "done";
      }
      const { bookings, pageSize } = await getChannexBookingsPage(
        apiKey,
        state.channexPropertyId,
        cursor.page,
        cursor.since,
      );
      for (const b of bookings) {
        const { bookingDate, isCancelled, rows } = bookingToNights(b);
        // Delete-then-insert stays ordered within the accumulated batch.
        pending.push(db().prepare(`DELETE FROM rev_night WHERE pid = ? AND booking_id = ?`).bind(pid, b.id));
        for (const r of rows) {
          pending.push(
            db()
              .prepare(
                `INSERT INTO rev_night
                   (pid, booking_id, room_seq, stay_date, rate_minor, currency, booking_date,
                    cancellation_date, is_cancelled, lead_time, los, ota, adults, children)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                pid,
                b.id,
                r.roomSeq,
                r.stayDate,
                r.rateMinor,
                b.currency ?? null,
                bookingDate,
                isCancelled ? cursor.startedAt.slice(0, 10) : null,
                isCancelled,
                r.leadTime,
                r.los,
                b.otaName ?? null,
                r.adults,
                r.children,
              ),
          );
        }
        if (pending.length >= BATCH_STMTS) await flush();
      }
      // Commit the page's rows BEFORE persisting the cursor past it, so a
      // killed invocation never skips uncommitted bookings on resume.
      await flush();
      const advanced: NonNullable<RevmanState["cursor"]> = {
        ...cursor,
        page: cursor.page + 1,
        imported: cursor.imported + bookings.length,
      };
      if (pageSize < 100) {
        await completeImport(pid, state, advanced);
        return "done";
      }
      state = {
        ...state,
        progressCount: advanced.imported,
        progressAt: new Date().toISOString(),
        cursor: advanced,
      };
      await writeState(pid, state);
    }
    return "more";
  } catch (err) {
    await writeState(pid, {
      ...state,
      importStatus: "error",
      error: err instanceof Error ? err.message : "Import failed.",
      progressCount: undefined,
      progressAt: undefined,
      cursor: undefined,
    });
    throw err;
  }
}

/** Fire-and-forget request to our own /api/revman-continue so the NEXT chunk
 *  runs in a fresh invocation with fresh limits. Signed with the session
 *  secret; if the self-fetch can't get through (misconfigured APP_URL), the
 *  admin page's 4s poll drives continuation instead. */
function kickContinuation(pid: string): void {
  const work = (async () => {
    const { hmacSha256Hex } = await import("./hmac.server");
    const sig = await hmacSha256Hex(getConfig().sessionSecret, `revman-continue:${pid}`);
    const base = getConfig().appUrl.replace(/\/+$/, "");
    await fetch(`${base}/api/revman-continue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid, sig }),
    });
  })().catch((err) => console.log(`[revman] continuation kick failed for ${pid}: ${err}`));
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}

/** Run one chunk of a pending import and chain the next. `onlyIfStale` is the
 *  drive-by mode used by the admin page's poll: it skips when another chunk
 *  runner looks alive, so polls don't duplicate the self-fetch chain. */
export async function continueRevmanImport(pid: string, opts: { onlyIfStale?: boolean } = {}): Promise<void> {
  const state = await readState(pid);
  if (!state || state.importStatus !== "running" || !state.cursor) return;
  if (opts.onlyIfStale && state.progressAt && Date.now() - Date.parse(state.progressAt) < CHUNK_ACTIVE_MS) return;
  const result = await runImportChunk(pid).catch((err) => {
    console.log(`[revman] import chunk failed for ${pid}: ${err}`);
    return "idle" as const;
  });
  if (result === "more") kickContinuation(pid);
}

/** Drive-by nudge from the admin page's poll: fire-and-forget, skips when a
 *  chunk runner is already alive. Keeps the chain moving even if the signed
 *  self-fetch can't reach the Worker (misconfigured APP_URL). */
export function nudgeRevmanImport(pid: string): void {
  const work = continueRevmanImport(pid, { onlyIfStale: true }).catch(() => {});
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}

/** Start (or resume) an import and return right away; chunks run across
 *  follow-up invocations. `full` re-pulls the whole history (drift recovery);
 *  otherwise only revisions since the last import. Refuses while a run is
 *  genuinely alive; a stalled run RESUMES from its cursor instead of starting
 *  over — that's what lets very large properties finish. */
export async function importRevmanBookings(pid: string, opts: { full: boolean }): Promise<void> {
  const state = await readState(pid);
  if (!state) throw new Error("Revenue management is not connected.");
  if (state.importStatus === "running" && !importLooksStalled(state)) {
    throw new Error("An import is already running.");
  }
  const resume = state.cursor !== undefined && importLooksStalled(state);
  const cursor: NonNullable<RevmanState["cursor"]> = resume
    ? state.cursor!
    : {
        full: opts.full,
        since:
          !opts.full && state.lastImportAt
            ? new Date(Date.parse(state.lastImportAt) - 86_400_000).toISOString()
            : undefined,
        page: 1,
        imported: 0,
        startedAt: new Date().toISOString(),
      };
  const next: RevmanState = {
    ...state,
    importStatus: "running",
    progressCount: cursor.imported,
    progressAt: new Date().toISOString(),
    cursor,
  };
  await writeState(pid, next);
  const work = continueRevmanImport(pid).catch((err) => console.log(`[revman] import failed for ${pid}: ${err}`));
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}

/** Cron: incremental import for every connected property; each successful
 *  import also freezes the day's total-demand snapshot. Failures are
 *  per-property (logged + stored on the connection) and never abort the rest. */
export async function scheduledRevmanImport(): Promise<void> {
  const kv = getConfigKV();
  if (!kv || !getDB()) return;
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: "revman:", cursor });
    for (const entry of page.keys) {
      const pid = entry.name.slice("revman:".length);
      try {
        const state = await readState(pid);
        if (!state) continue;
        // Starts (or resumes) a chunked import; the chain of self-invocations
        // does the actual work. Throws when a run is already alive — fine.
        await importRevmanBookings(pid, { full: false });
      } catch (err) {
        console.log(`[cron] revman import failed for ${pid}: ${err}`);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

// ---------------------------------------------------------------------------
// Summary for the admin page

export interface RevmanSummary {
  nights: number;
  bookings: number;
  cancelledBookings: number;
  firstStay?: string;
  lastStay?: string;
}

export async function getRevmanSummary(pid: string): Promise<RevmanSummary> {
  await ensureSchema();
  const row = (
    await db()
      .prepare(
        `SELECT COUNT(*) AS nights,
                COUNT(DISTINCT booking_id) AS bookings,
                COUNT(DISTINCT CASE WHEN is_cancelled = 1 THEN booking_id END) AS cancelled,
                MIN(stay_date) AS first_stay,
                MAX(stay_date) AS last_stay
         FROM rev_night WHERE pid = ?`,
      )
      .bind(pid)
      .first()
  ) as Record<string, unknown> | null;
  return {
    nights: Number(row?.nights ?? 0),
    bookings: Number(row?.bookings ?? 0),
    cancelledBookings: Number(row?.cancelled ?? 0),
    firstStay: (row?.first_stay as string) ?? undefined,
    lastStay: (row?.last_stay as string) ?? undefined,
  };
}
