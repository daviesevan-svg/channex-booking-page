// Competitor set storage + ranking (server). A per-property list of nearby
// hotels the hotelier competes with, entered by hand (v1 — no scraping). Our
// own hotel lives in the same list as an editable "self" row, pre-filled from
// internal direct-booking reviews, so the ranking shows where we sit. The
// Booking.com reference (URL or hotel_id) is stored now but only used later,
// when daily competitor prices are added.

import { getDB } from "./config.server";
import { getOverrides } from "./overrides.server";
import { getPublicReviews } from "./reviews.server";
import { rankCompSet, selfStanding, type CompHotel, type RankedHotel } from "./revman-compset";

function db(): D1Database {
  const d = getDB();
  if (!d) throw new Error("D1 database (binding DB) is not configured.");
  return d;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await db()
    .prepare(
      `CREATE TABLE IF NOT EXISTS rev_comp (
        pid TEXT NOT NULL,
        comp_id TEXT NOT NULL,
        name TEXT NOT NULL,
        star_class INTEGER,
        review_score REAL,
        review_count INTEGER,
        booking_ref TEXT,
        is_self INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (pid, comp_id)
      )`,
    )
    .run();
  schemaReady = true;
}

interface CompRow {
  comp_id: string;
  name: string;
  star_class: number | null;
  review_score: number | null;
  review_count: number | null;
  booking_ref: string | null;
  is_self: number;
}

const toHotel = (r: CompRow): CompHotel => ({
  id: r.comp_id,
  name: r.name,
  isSelf: r.is_self === 1,
  starClass: r.star_class ?? undefined,
  reviewScore: r.review_score ?? undefined,
  reviewCount: r.review_count ?? undefined,
  bookingRef: r.booking_ref ?? undefined,
});

async function listRows(pid: string): Promise<CompRow[]> {
  await ensureSchema();
  const res = await db()
    .prepare(
      `SELECT comp_id, name, star_class, review_score, review_count, booking_ref, is_self
       FROM rev_comp WHERE pid = ?`,
    )
    .bind(pid)
    .all<CompRow>();
  return res.results ?? [];
}

/** Creates the editable "self" row once, pre-filled from the property name and
 *  internal direct-booking reviews (5-star average → /10). Idempotent. */
async function ensureSelfRow(pid: string): Promise<void> {
  await ensureSchema();
  const existing = await db()
    .prepare(`SELECT comp_id FROM rev_comp WHERE pid = ? AND is_self = 1 LIMIT 1`)
    .bind(pid)
    .first<{ comp_id: string }>();
  if (existing) return;

  const [overrides, reviews] = await Promise.all([getOverrides(pid), getPublicReviews(pid, 1)]);
  const name = overrides.hotelName?.trim() || "Your hotel";
  // Internal reviews are 0–5; the comp set works in 0–10 (OTA scale).
  const score = reviews.count > 0 ? Math.round(reviews.average * 2 * 10) / 10 : null;
  await db()
    .prepare(
      `INSERT INTO rev_comp (pid, comp_id, name, star_class, review_score, review_count, booking_ref, is_self, created_at)
       VALUES (?, 'self', ?, NULL, ?, ?, NULL, 1, ?)`,
    )
    .bind(pid, name, score, reviews.count > 0 ? reviews.count : null, new Date().toISOString())
    .run();
}

const clampScore = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(10, Math.round(n * 10) / 10) : null;
};
const clampCount = (v: unknown): number | null => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const clampStar = (v: unknown): number | null => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
};

export interface CompInput {
  name: string;
  starClass?: unknown;
  reviewScore?: unknown;
  reviewCount?: unknown;
  bookingRef?: string;
}

/** Canonical Booking hotel path (drops query + locale), so the same hotel added
 *  from different links/searches dedupes to one row. */
function canonicalRef(ref: string | undefined): string | null {
  const r = ref?.trim();
  if (!r) return null;
  try {
    const path = r.startsWith("http") ? new URL(r).pathname : r.split("?")[0];
    return path.replace(/\.[a-z]{2}(-[a-z]{2})?\.html$/i, ".html");
  } catch {
    return r.split("?")[0];
  }
}

/** Adds a competitor — or updates the matching one instead of duplicating it, so
 *  re-running discovery / "add selected" is idempotent. A match is the same
 *  Booking reference (canonicalised) or, absent a reference, the same name. */
export async function addCompetitor(pid: string, input: CompInput): Promise<void> {
  await ensureSchema();
  const name = input.name.trim();
  if (!name) throw new Error("A competitor name is required.");
  const ref = canonicalRef(input.bookingRef);

  const existing = await db()
    .prepare(
      `SELECT comp_id FROM rev_comp
       WHERE pid = ? AND is_self = 0
         AND ( (? IS NOT NULL AND booking_ref = ?) OR (? IS NULL AND lower(name) = lower(?)) )
       LIMIT 1`,
    )
    .bind(pid, ref, ref, ref, name)
    .first<{ comp_id: string }>();
  if (existing) {
    await updateCompetitor(pid, existing.comp_id, { ...input, bookingRef: ref ?? input.bookingRef });
    return;
  }

  await db()
    .prepare(
      `INSERT INTO rev_comp (pid, comp_id, name, star_class, review_score, review_count, booking_ref, is_self, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .bind(
      pid,
      crypto.randomUUID(),
      name,
      clampStar(input.starClass),
      clampScore(input.reviewScore),
      clampCount(input.reviewCount),
      ref,
      new Date().toISOString(),
    )
    .run();
}

/** Edits any row (competitor or self). The self row's name and quality inputs
 *  are editable; its Booking reference stays null. */
export async function updateCompetitor(pid: string, compId: string, input: CompInput): Promise<void> {
  await ensureSchema();
  const name = input.name.trim();
  if (!name) throw new Error("A name is required.");
  await db()
    .prepare(
      `UPDATE rev_comp SET name = ?, star_class = ?, review_score = ?, review_count = ?, booking_ref = ?
       WHERE pid = ? AND comp_id = ?`,
    )
    .bind(
      name,
      clampStar(input.starClass),
      clampScore(input.reviewScore),
      clampCount(input.reviewCount),
      input.bookingRef?.trim() || null,
      pid,
      compId,
    )
    .run();
}

/** Scores the self row from discovered Booking.com data, so our hotel ranks in
 *  the set on the same basis as its competitors (that's what gives it a
 *  placement). Updates only the rating fields + Booking ref; the self name is
 *  left untouched. Only touches an existing self row (no-op if none). */
export async function setSelfRating(
  pid: string,
  input: { starClass?: unknown; reviewScore?: unknown; reviewCount?: unknown; bookingRef?: string },
): Promise<void> {
  await ensureSchema();
  await db()
    .prepare(
      `UPDATE rev_comp SET star_class = ?, review_score = ?, review_count = ?, booking_ref = ?
       WHERE pid = ? AND is_self = 1`,
    )
    .bind(
      clampStar(input.starClass),
      clampScore(input.reviewScore),
      clampCount(input.reviewCount),
      input.bookingRef?.trim() || null,
      pid,
    )
    .run();
}

/** Removes a competitor. The self row can't be removed (guarded). */
export async function removeCompetitor(pid: string, compId: string): Promise<void> {
  await ensureSchema();
  await db().prepare(`DELETE FROM rev_comp WHERE pid = ? AND comp_id = ? AND is_self = 0`).bind(pid, compId).run();
}

export async function wipeCompSet(pid: string): Promise<void> {
  await ensureSchema();
  await db().prepare(`DELETE FROM rev_comp WHERE pid = ?`).bind(pid).run();
}

/** Removes duplicate competitor rows (keeps the earliest of each Booking ref,
 *  or of each name when there's no ref). Self-heals sets that gathered dupes
 *  before add-time dedupe existed; also drops any orphaned duplicate prices. */
export async function dedupeCompSet(pid: string): Promise<void> {
  await ensureSchema();
  await db().batch([
    db()
      .prepare(
        `DELETE FROM rev_comp WHERE pid = ? AND is_self = 0 AND booking_ref IS NOT NULL AND rowid NOT IN (
           SELECT MIN(rowid) FROM rev_comp WHERE pid = ? AND is_self = 0 AND booking_ref IS NOT NULL GROUP BY booking_ref )`,
      )
      .bind(pid, pid),
    db()
      .prepare(
        `DELETE FROM rev_comp WHERE pid = ? AND is_self = 0 AND booking_ref IS NULL AND rowid NOT IN (
           SELECT MIN(rowid) FROM rev_comp WHERE pid = ? AND is_self = 0 AND booking_ref IS NULL GROUP BY lower(name) )`,
      )
      .bind(pid, pid),
  ]);
}

export interface CompSetView {
  ranked: RankedHotel[];
  /** Our hotel's rank and how many hotels in the set are rated. */
  standing: { position: number | null; rated: number };
  /** True when the self row has no score yet (prompt the hotelier to fill it). */
  selfUnrated: boolean;
}

/** The ranked competitor set including our own hotel. */
export async function getCompSet(pid: string): Promise<CompSetView> {
  await ensureSelfRow(pid);
  await dedupeCompSet(pid); // self-heal any pre-existing duplicates
  const hotels = (await listRows(pid)).map(toHotel);
  const ranked = rankCompSet(hotels);
  const self = ranked.find((h) => h.isSelf);
  return {
    ranked,
    standing: selfStanding(ranked),
    selfUnrated: self ? self.qualityIndex === null : true,
  };
}
