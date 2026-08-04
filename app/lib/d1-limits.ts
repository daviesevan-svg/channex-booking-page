// D1's bound-parameter ceiling, and the chunking that keeps queries under it.
//
// D1 rejects any query carrying more than 100 bound parameters:
//
//   D1_ERROR: too many SQL variables at offset 281: SQLITE_ERROR
//
// The trap is that this is FAR below SQLite's own ceiling (999 on older builds,
// 32766 since 3.32). Code written against the SQLite number reads as safely
// under the limit and works fine until a payload gets big enough — which is how
// a Channex push touching 100+ dates started failing in production while a
// guard set at 500 never tripped.
//
// Measured against the production database on 2026-08-02: 100 parameters
// succeed, 101 fail. The `offset` in the error is the character position of the
// offending placeholder in the SQL text, which is how to work out WHICH query
// threw when several run together — count the prefix, then two characters per
// `?,` before it.

/** Maximum bound parameters D1 accepts in a single query. */
export const D1_MAX_BOUND_PARAMS = 100;

/** Split `items` so each chunk fits in one query alongside `reserved` other
 *  bound parameters (the ones that aren't part of the list — a hotel_code, a
 *  date range, a LIMIT).
 *
 *  Returns `[]` for no items, so `for (const chunk of ...)` runs zero times
 *  rather than issuing a query with an empty `IN ()`. */
export function chunkForBinds<T>(items: readonly T[], reserved = 0): T[][] {
  const perQuery = D1_MAX_BOUND_PARAMS - reserved;
  if (perQuery < 1) {
    throw new Error(`chunkForBinds: ${reserved} reserved parameters leaves no room for a list (max ${D1_MAX_BOUND_PARAMS})`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += perQuery) out.push(items.slice(i, i + perQuery));
  return out;
}

/** `?,?,?` for an `IN (…)` list of `n` values. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

/** How many rows of `paramsPerRow` fit in one statement, after `reserved`
 *  parameters that aren't part of the rows. Throws rather than return 0: a row
 *  too wide to bind is a caller bug, and a broken statement is worse than a
 *  loud failure. */
export function rowsPerStatement(paramsPerRow: number, reserved = 0): number {
  const budget = D1_MAX_BOUND_PARAMS - reserved;
  const n = Math.floor(budget / paramsPerRow);
  if (n < 1) throw new Error(`rowsPerStatement: a row of ${paramsPerRow} parameters does not fit in ${budget}`);
  return n;
}

/** `(?,?),(?,?)` — the VALUES list of a multi-row INSERT.
 *
 *  Worth knowing before using this on an upsert: if two rows in the SAME
 *  statement hit the same conflict target, D1's SQLite applies them in order and
 *  the LAST one wins — measured, not assumed. That matches what a sequence of
 *  single-row statements would have done, so packing rows together cannot change
 *  the outcome of a payload that repeats a key. */
export function valuesTuples(rowCount: number, paramsPerRow: number): string {
  return Array.from({ length: rowCount }, () => `(${placeholders(paramsPerRow)})`).join(",");
}

/** Split rows so each group is one statement's worth. Order is preserved, which
 *  is what keeps last-wins meaningful across the split as well as within it. */
export function chunkRows<T>(rows: readonly T[], paramsPerRow: number, reserved = 0): T[][] {
  const per = rowsPerStatement(paramsPerRow, reserved);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += per) out.push(rows.slice(i, i + per));
  return out;
}
