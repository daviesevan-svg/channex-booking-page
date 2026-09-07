import { ensureSchema } from "../ari/schema.server";
import { db, d1Retry } from "../d1.server";
import { chunkRows, valuesTuples } from "../d1-limits";

/** Appended to the same atomic D1 batch as ARI upserts. A Worker ending after
 * commit but before its durable enqueue cannot make the change disappear. */
export function googleAriRepairStatements(D: D1Database, pids: Iterable<string>, revision: string): D1PreparedStatement[] {
  return chunkRows([...pids], 2).map((chunk) => D.prepare(
    `INSERT INTO google_ari_repair (pid, revision) VALUES ${valuesTuples(chunk.length, 2)}
     ON CONFLICT(pid) DO UPDATE SET revision=excluded.revision, next_attempt=0`,
  ).bind(...chunk.flatMap((pid) => [pid, revision])));
}

export async function clearGoogleAriRepair(pid: string, revision: string): Promise<void> {
  await d1Retry(() => ensureSchema());
  await d1Retry(() => db().prepare("DELETE FROM google_ari_repair WHERE pid=? AND revision=?").bind(pid, revision).run());
}

/** Minute cron: recover at most 25 properties. A full ARI snapshot is the safe
 * bounded fallback when exact notification metadata was never durably queued.
 * Timestamped retries let healthy properties advance past a failing property. */
export async function retryGoogleAriRepairs(now = Date.now()): Promise<void> {
  const { queueGoogleAriPush } = await import("./push.server");
  await d1Retry(() => ensureSchema());
  const D = db();
  const rows = await d1Retry(() => D.prepare(
    "SELECT pid, revision FROM google_ari_repair WHERE next_attempt<=? ORDER BY next_attempt, pid LIMIT 25",
  ).bind(now).all<{ pid: string; revision: string }>());
  for (const { pid, revision } of rows.results) {
    try {
      await queueGoogleAriPush(pid, ["ari"]);
      await clearGoogleAriRepair(pid, revision);
    } catch (error) {
      await d1Retry(() => D.prepare("UPDATE google_ari_repair SET next_attempt=? WHERE pid=? AND revision=?").bind(now + 60_000, pid, revision).run());
      console.log(`[google-ari] enqueue repair retained for ${pid}: ${error instanceof Error ? error.message : error}`);
    }
  }
}
