// Vacation-rental competitor-set storage + ranking (server). Per-property list
// of comparable short-term rentals, discovered from Airbnb (see
// vr-compset-discovery) and confirmed by the host. Our own unit lives in the
// same list as an editable "self" row so the ranking shows where we sit among
// same-type places. The Airbnb ref is stored now and used later by the
// per-night price feed. Mirrors revman-compset.server (hotels).

import { getDB } from "./config.server";
import { getOverrides } from "./overrides.server";
import { getPublicReviews } from "./reviews.server";
import { rankVrSet, vrSelfStanding, type PlaceClass, type RankedVrUnit, type VrUnit } from "./vr-compset";

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
      `CREATE TABLE IF NOT EXISTS vr_comp (
        pid TEXT NOT NULL,
        comp_id TEXT NOT NULL,
        name TEXT NOT NULL,
        place_type TEXT,
        place_class TEXT,
        review_score REAL,
        review_count INTEGER,
        airbnb_ref TEXT,
        is_self INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (pid, comp_id)
      )`,
    )
    .run();
  schemaReady = true;
}

interface VrCompRow {
  comp_id: string;
  name: string;
  place_type: string | null;
  place_class: string | null;
  review_score: number | null;
  review_count: number | null;
  airbnb_ref: string | null;
  is_self: number;
}

const toUnit = (r: VrCompRow): VrUnit => ({
  id: r.comp_id,
  name: r.name,
  isSelf: r.is_self === 1,
  placeType: r.place_type ?? undefined,
  placeClass: (r.place_class as PlaceClass | null) ?? undefined,
  reviewScore: r.review_score ?? undefined,
  reviewCount: r.review_count ?? undefined,
  airbnbRef: r.airbnb_ref ?? undefined,
});

async function listRows(pid: string): Promise<VrCompRow[]> {
  await ensureSchema();
  const res = await db()
    .prepare(
      `SELECT comp_id, name, place_type, place_class, review_score, review_count, airbnb_ref, is_self
       FROM vr_comp WHERE pid = ?`,
    )
    .bind(pid)
    .all<VrCompRow>();
  return res.results ?? [];
}

/** Creates the editable "self" row once, pre-filled from the property name and
 *  internal direct-booking reviews. Defaults the class to "entire" — a
 *  single-unit rental is almost always a whole place — which the host can edit
 *  or overwrite by designating their own Airbnb listing. Idempotent. */
async function ensureSelfRow(pid: string): Promise<void> {
  await ensureSchema();
  const existing = await db()
    .prepare(`SELECT comp_id FROM vr_comp WHERE pid = ? AND is_self = 1 LIMIT 1`)
    .bind(pid)
    .first<{ comp_id: string }>();
  if (existing) return;

  const [overrides, reviews] = await Promise.all([getOverrides(pid), getPublicReviews(pid, 1)]);
  const name = overrides.hotelName?.trim() || "Your place";
  // Both internal reviews and Airbnb ratings are on the 0–5 scale, so no
  // rescaling — unlike the hotel set, which converts /5 → /10.
  const score = reviews.count > 0 ? Math.round(reviews.average * 100) / 100 : null;
  await db()
    .prepare(
      `INSERT INTO vr_comp (pid, comp_id, name, place_type, place_class, review_score, review_count, airbnb_ref, is_self, created_at)
       VALUES (?, 'self', ?, NULL, 'entire', ?, ?, NULL, 1, ?)`,
    )
    .bind(pid, name, score, reviews.count > 0 ? reviews.count : null, new Date().toISOString())
    .run();
}

const clampScore = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(5, Math.round(n * 100) / 100) : null;
};
const clampCount = (v: unknown): number | null => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const cleanClass = (v: unknown): PlaceClass | null => (v === "entire" || v === "private" ? v : null);
const cleanType = (v: unknown): string | null => {
  const s = String(v ?? "").trim().toLowerCase();
  return s ? s.slice(0, 40) : null;
};

export interface VrCompInput {
  name: string;
  placeType?: unknown;
  placeClass?: unknown;
  reviewScore?: unknown;
  reviewCount?: unknown;
  airbnbRef?: string;
}

/** Airbnb room id from a ref or full room URL, so the same listing added from a
 *  URL or a bare id dedupes to one row. */
function canonicalRef(ref: string | undefined): string | null {
  const r = ref?.trim();
  if (!r) return null;
  const m = r.match(/\/rooms\/(\d+)/);
  if (m) return m[1];
  return /^\d+$/.test(r) ? r : r;
}

/** Adds a comp — or updates the matching one instead of duplicating it, so
 *  re-running discovery / "add selected" is idempotent. Matches on the same
 *  Airbnb ref or, absent a ref, the same name. */
export async function addVrComp(pid: string, input: VrCompInput): Promise<void> {
  await ensureSchema();
  const name = input.name.trim();
  if (!name) throw new Error("A name is required.");
  const ref = canonicalRef(input.airbnbRef);

  const existing = await db()
    .prepare(
      `SELECT comp_id FROM vr_comp
       WHERE pid = ? AND is_self = 0
         AND ( (? IS NOT NULL AND airbnb_ref = ?) OR (? IS NULL AND lower(name) = lower(?)) )
       LIMIT 1`,
    )
    .bind(pid, ref, ref, ref, name)
    .first<{ comp_id: string }>();
  if (existing) {
    await updateVrComp(pid, existing.comp_id, { ...input, airbnbRef: ref ?? input.airbnbRef });
    return;
  }

  await db()
    .prepare(
      `INSERT INTO vr_comp (pid, comp_id, name, place_type, place_class, review_score, review_count, airbnb_ref, is_self, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .bind(
      pid,
      crypto.randomUUID(),
      name,
      cleanType(input.placeType),
      cleanClass(input.placeClass),
      clampScore(input.reviewScore),
      clampCount(input.reviewCount),
      ref,
      new Date().toISOString(),
    )
    .run();
}

/** Edits any row (comp or self). All fields editable; the self row keeps its
 *  own name and can carry a type/class the host sets. */
export async function updateVrComp(pid: string, compId: string, input: VrCompInput): Promise<void> {
  await ensureSchema();
  const name = input.name.trim();
  if (!name) throw new Error("A name is required.");
  await db()
    .prepare(
      `UPDATE vr_comp SET name = ?, place_type = ?, place_class = ?, review_score = ?, review_count = ?, airbnb_ref = ?
       WHERE pid = ? AND comp_id = ?`,
    )
    .bind(
      name,
      cleanType(input.placeType),
      cleanClass(input.placeClass),
      clampScore(input.reviewScore),
      clampCount(input.reviewCount),
      canonicalRef(input.airbnbRef),
      pid,
      compId,
    )
    .run();
}

/** Designates the host's own Airbnb listing: sets the self row's type/class,
 *  rating and ref from a discovered listing, so our unit ranks on the same
 *  basis as its comps. Leaves the self name untouched. No-op if no self row. */
export async function setSelfListing(
  pid: string,
  input: { placeType?: unknown; placeClass?: unknown; reviewScore?: unknown; reviewCount?: unknown; airbnbRef?: string },
): Promise<void> {
  await ensureSchema();
  await db()
    .prepare(
      `UPDATE vr_comp SET place_type = ?, place_class = ?, review_score = ?, review_count = ?, airbnb_ref = ?
       WHERE pid = ? AND is_self = 1`,
    )
    .bind(
      cleanType(input.placeType),
      cleanClass(input.placeClass),
      clampScore(input.reviewScore),
      clampCount(input.reviewCount),
      canonicalRef(input.airbnbRef),
      pid,
    )
    .run();
}

/** Removes a comp. The self row can't be removed (guarded). */
export async function removeVrComp(pid: string, compId: string): Promise<void> {
  await ensureSchema();
  await db().prepare(`DELETE FROM vr_comp WHERE pid = ? AND comp_id = ? AND is_self = 0`).bind(pid, compId).run();
}

export async function wipeVrCompSet(pid: string): Promise<void> {
  await ensureSchema();
  await db().prepare(`DELETE FROM vr_comp WHERE pid = ?`).bind(pid).run();
}

/** Removes duplicate comp rows (keeps the earliest of each Airbnb ref, or of
 *  each name when there's no ref). Self-heals sets that gathered dupes. */
export async function dedupeVrCompSet(pid: string): Promise<void> {
  await ensureSchema();
  await db().batch([
    db()
      .prepare(
        `DELETE FROM vr_comp WHERE pid = ? AND is_self = 0 AND airbnb_ref IS NOT NULL AND rowid NOT IN (
           SELECT MIN(rowid) FROM vr_comp WHERE pid = ? AND is_self = 0 AND airbnb_ref IS NOT NULL GROUP BY airbnb_ref )`,
      )
      .bind(pid, pid),
    db()
      .prepare(
        `DELETE FROM vr_comp WHERE pid = ? AND is_self = 0 AND airbnb_ref IS NULL AND rowid NOT IN (
           SELECT MIN(rowid) FROM vr_comp WHERE pid = ? AND is_self = 0 AND airbnb_ref IS NULL GROUP BY lower(name) )`,
      )
      .bind(pid, pid),
  ]);
}

export interface VrCompSetView {
  ranked: RankedVrUnit[];
  /** Our unit's rank and how many units in the set are rated. */
  standing: { position: number | null; rated: number };
  /** True when the self row has no score yet. */
  selfUnrated: boolean;
  /** True when the self row has no type set (matching can't gate without it). */
  selfUntyped: boolean;
}

/** The ranked comp set including our own unit. */
export async function getVrCompSet(pid: string): Promise<VrCompSetView> {
  await ensureSelfRow(pid);
  await dedupeVrCompSet(pid);
  const units = (await listRows(pid)).map(toUnit);
  const ranked = rankVrSet(units);
  const self = ranked.find((u) => u.isSelf);
  return {
    ranked,
    standing: vrSelfStanding(ranked),
    selfUnrated: self ? self.qualityIndex === null : true,
    selfUntyped: self ? !self.placeClass : true,
  };
}
