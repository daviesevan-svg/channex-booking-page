// Guest reviews — one per booking, stored in D1 (per-row writes; a KV list
// would clobber under concurrent submissions). The full review is JSON in the
// row; indexed columns cover the admin list and the public display.
import { getDB } from "./config.server";
import type { ReviewRecord } from "./reviews";

export type { ReviewRecord } from "./reviews";

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
      `CREATE TABLE IF NOT EXISTS review (
        pid TEXT NOT NULL, booking_id TEXT NOT NULL, id TEXT NOT NULL,
        created_at TEXT NOT NULL, stars INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL,
        PRIMARY KEY (pid, booking_id)
      )`,
    )
    .run();
  schemaReady = true;
}

const parse = (rows: { json: string }[]): ReviewRecord[] => rows.map((r) => JSON.parse(r.json) as ReviewRecord);

/** Create or update the review for a booking (the guest may revise via the
 *  same emailed link). Preserves createdAt + the hotel's response on update. */
export async function upsertReview(
  pid: string,
  input: Omit<ReviewRecord, "id" | "createdAt" | "updatedAt" | "hidden" | "response">,
): Promise<ReviewRecord> {
  await ensureSchema();
  const existing = await getReviewByBooking(pid, input.bookingId);
  const now = new Date().toISOString();
  const record: ReviewRecord = {
    ...input,
    id: existing?.id ?? crypto.randomUUID(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    hidden: existing?.hidden,
    response: existing?.response,
  };
  await db()
    .prepare(
      `INSERT INTO review (pid, booking_id, id, created_at, stars, hidden, json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pid, booking_id) DO UPDATE SET stars=excluded.stars, json=excluded.json`,
    )
    .bind(pid, record.bookingId, record.id, record.createdAt, record.stars, record.hidden ? 1 : 0, JSON.stringify(record))
    .run();
  return record;
}

export async function getReviewByBooking(pid: string, bookingId: string): Promise<ReviewRecord | null> {
  await ensureSchema();
  const row = await db()
    .prepare(`SELECT json FROM review WHERE pid = ? AND booking_id = ?`)
    .bind(pid, bookingId)
    .first<{ json: string }>();
  return row ? (JSON.parse(row.json) as ReviewRecord) : null;
}

/** All reviews for the admin list, newest first. */
export async function listReviews(pid: string): Promise<ReviewRecord[]> {
  await ensureSchema();
  const { results } = await db()
    .prepare(`SELECT json FROM review WHERE pid = ? ORDER BY created_at DESC`)
    .bind(pid)
    .all<{ json: string }>();
  return parse(results ?? []);
}

/** The strictly-public projection of a review. Loader data is serialized into
 *  the page HTML, so anything returned here IS published — the private note,
 *  the booking id (the review-edit credential) and moderation state must never
 *  be included. */
export interface PublicReview {
  id: string;
  stars: number;
  publicText: string;
  guestName: string;
  createdAt: string;
  response: { text: string } | null;
}

/** Public reviews (not hidden, with text) + the aggregate, for the guest page. */
export async function getPublicReviews(
  pid: string,
  limit = 6,
): Promise<{ average: number; count: number; reviews: PublicReview[] }> {
  await ensureSchema();
  const agg = await db()
    .prepare(`SELECT COUNT(*) AS n, AVG(stars) AS avg FROM review WHERE pid = ? AND hidden = 0`)
    .bind(pid)
    .first<{ n: number; avg: number | null }>();
  const { results } = await db()
    .prepare(
      `SELECT json FROM review WHERE pid = ? AND hidden = 0
       AND json_extract(json, '$.publicText') IS NOT NULL AND json_extract(json, '$.publicText') != ''
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(pid, limit)
    .all<{ json: string }>();
  return {
    average: Math.round((agg?.avg ?? 0) * 10) / 10,
    count: agg?.n ?? 0,
    reviews: parse(results ?? []).map((r) => ({
      id: r.id,
      stars: r.stars,
      publicText: r.publicText ?? "",
      guestName: r.guestName,
      createdAt: r.createdAt,
      response: r.response ? { text: r.response.text } : null,
    })),
  };
}

/** Update the mutable admin-side fields (hide/unhide, response). */
async function patchReview(pid: string, bookingId: string, patch: Partial<ReviewRecord>): Promise<ReviewRecord | null> {
  const existing = await getReviewByBooking(pid, bookingId);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  await db()
    .prepare(`UPDATE review SET hidden = ?, json = ? WHERE pid = ? AND booking_id = ?`)
    .bind(next.hidden ? 1 : 0, JSON.stringify(next), pid, bookingId)
    .run();
  return next;
}

export async function setReviewHidden(pid: string, bookingId: string, hidden: boolean) {
  return patchReview(pid, bookingId, { hidden });
}

export async function setReviewResponse(pid: string, bookingId: string, text: string, by?: string) {
  const trimmed = text.trim();
  return patchReview(pid, bookingId, {
    response: trimmed ? { text: trimmed, at: new Date().toISOString(), by } : undefined,
  });
}

export async function deleteReview(pid: string, bookingId: string): Promise<void> {
  await ensureSchema();
  await db().prepare(`DELETE FROM review WHERE pid = ? AND booking_id = ?`).bind(pid, bookingId).run();
}
