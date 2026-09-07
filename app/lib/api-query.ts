/** Canonical ISO calendar date, rejecting JavaScript's February 30 rollover. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** Keep the existing per-endpoint limit cap, but reject malformed, fractional,
 *  negative and unsafe values instead of passing them into SQL. */
export function bookingPageParams(
  query: URLSearchParams,
  maxLimit: number,
): { limit: number; offset: number } | { error: string } {
  const limit = query.get("limit") ?? "50";
  const offset = query.get("offset") ?? "0";
  if (!/^\d+$/.test(limit) || !Number.isSafeInteger(Number(limit)) || Number(limit) < 1) {
    return { error: "`limit` must be a positive safe integer." };
  }
  if (!/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))) {
    return { error: "`offset` must be a non-negative safe integer." };
  }
  return { limit: Math.min(Number(limit), maxLimit), offset: Number(offset) };
}
