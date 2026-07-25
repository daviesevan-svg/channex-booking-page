// Rate derivation — pure, client-safe. A hotel usually sells one room type on
// several rate plans (flexible, non-refundable, breakfast-included…) whose
// prices move together: revenue management decides ONE number per room type
// and the rest follow at a fixed relationship.
//
// So each room type nominates a MASTER rate plan. Suggestions are applied to
// the master, and every other rate plan for that room is derived from it. The
// relationship is either:
//   percent — "non-refundable is 10% under flexible". Scales with the master,
//             which is what discount tiers should do.
//   fixed   — "breakfast is £15 more". Stays £15 as the master moves, which a
//             percentage would wrongly inflate.
// Relationships are detected from the prices already loaded (see
// detectLink) so a hotelier doesn't have to type them in, then stay in effect
// until they change them.

/** Stable key for one (room type, rate plan) pair. Lives here rather than in
 *  the .server module so the admin UI can use it without dragging server-only
 *  code into the client bundle. */
export const cellKey = (roomId: string, rateId: string): string => `${roomId}|${rateId}`;

export type RateLinkMode = "percent" | "fixed";

export interface RateLink {
  mode: RateLinkMode;
  /** percent: -10 = 10% below the master. fixed: +15 = 15 major units above. */
  value: number;
}

/** The price a derived rate should carry for a given master price, in the same
 *  major units. Rounded to whole units (matching targetPrice) and never below
 *  zero. Guard clamping is the caller's job — guards are per property. */
export function deriveTarget(masterPrice: number, link: RateLink): number {
  const raw = link.mode === "percent" ? masterPrice * (1 + link.value / 100) : masterPrice + link.value;
  return Math.max(0, Math.round(raw));
}

export interface DetectedLink {
  /** Median of rate ÷ master across the observed dates, as a percentage
   *  difference (-10 = 10% below). Null when nothing comparable was seen. */
  percent: number | null;
  /** Median of rate − master across the observed dates, in major units. */
  fixed: number | null;
  /** How many dates both prices were seen on — low counts are weak evidence. */
  samples: number;
  /** Which relationship held more consistently across the samples; use as the
   *  default mode. Null when there's nothing to judge. */
  suggested: RateLinkMode | null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Spread of a list around its median — smaller means the relationship held
 *  more consistently. */
function spread(xs: number[], mid: number): number {
  if (xs.length === 0) return Infinity;
  return xs.reduce((sum, x) => sum + Math.abs(x - mid), 0) / xs.length;
}

/** Infers a rate's relationship to its master from prices already on the
 *  books. `byDate` pairs are (masterPrice, ratePrice) in major units for the
 *  same date; dates where either side is missing or non-positive are skipped.
 *
 *  Both candidate relationships are returned so the hotelier can choose, along
 *  with a suggestion: whichever varied LESS across the sample is the one that
 *  actually describes how this hotel prices the rate. A breakfast supplement
 *  looks like a steady +15 but a drifting percentage; a discount tier looks
 *  like a steady -10% but a drifting amount. */
export function detectLink(byDate: { master: number; rate: number }[]): DetectedLink {
  const ratios: number[] = [];
  const diffs: number[] = [];
  for (const { master, rate } of byDate) {
    if (!(master > 0) || !(rate > 0)) continue;
    ratios.push((rate / master - 1) * 100);
    diffs.push(rate - master);
  }
  const samples = ratios.length;
  const percent = median(ratios);
  const fixed = median(diffs);
  if (percent === null || fixed === null) return { percent: null, fixed: null, samples, suggested: null };

  // Compare consistency on a common footing: express the fixed-amount spread
  // as a percentage of the median master price, so the two are comparable.
  const masters = byDate.filter((d) => d.master > 0 && d.rate > 0).map((d) => d.master);
  const midMaster = median(masters) ?? 1;
  const percentSpread = spread(ratios, percent);
  const fixedSpreadAsPct = midMaster > 0 ? (spread(diffs, fixed) / midMaster) * 100 : Infinity;

  return {
    percent: Math.round(percent * 10) / 10,
    fixed: Math.round(fixed * 100) / 100,
    samples,
    // Ties (including a single sample, where both spreads are 0) favour
    // percent: it keeps discount tiers proportional as prices move, which is
    // the more common intent.
    suggested: fixedSpreadAsPct < percentSpread ? "fixed" : "percent",
  };
}

/** Turns a detection into a stored link using its suggested mode. */
export function linkFromDetection(d: DetectedLink): RateLink | null {
  if (d.suggested === null) return null;
  const value = d.suggested === "percent" ? d.percent : d.fixed;
  if (value === null) return null;
  return { mode: d.suggested, value };
}
