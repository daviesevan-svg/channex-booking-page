/** `Promise.all(items.map(fn))` with at most `limit` calls in flight, results
 *  in input order. For fan-outs over storage or the network where firing
 *  everything at once would trip the Worker's subrequest or memory limits, but
 *  one-at-a-time spends the whole request waiting on round trips. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
