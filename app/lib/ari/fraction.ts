// price_minor ↔ major-unit conversion for the `rate` table.
//
// `fraction_size` is per ROW, not per currency table: Channex sends it with
// every rate (0 for zero-decimal currencies like VND/JPY/KRW, 3 for BHD, 2 for
// most), and the manual grid always writes 2. A row must be decoded with the
// same exponent it was encoded with, which is why both directions live here.
//
// Both use `?? 2`, never `|| 2`: a fraction_size of 0 is a real value. `|| 2`
// on the read side once turned Channex's VND rows (stored whole-unit with
// fraction 0) into a ÷100 — a ₫500,000 rate displayed and charged as ₫5,000.

export const toMinor = (rate: string | number, fraction: number | null | undefined): number =>
  Math.round(Number(rate) * 10 ** (fraction ?? 2));

export const fromMinor = (minor: number, fraction: number | null | undefined): number =>
  minor / 10 ** (fraction ?? 2);
