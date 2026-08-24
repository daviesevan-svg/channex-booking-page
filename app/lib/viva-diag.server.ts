// Persist the most recent Viva diagnostics run per property. A failed connect
// attempt is usually made by the HOTEL, not by us — without this, the report
// only exists on their screen and the support ticket gets written days later
// from memory. One row per property (latest run wins), queryable from D1.
import { db, schemaOnce } from "./d1.server";
import type { VivaDiagnostics } from "./viva.server";

const ensureSchema = schemaOnce((d) => [
  d.prepare(
    `CREATE TABLE IF NOT EXISTS viva_diag (
      property_id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      report TEXT NOT NULL
    )`,
  ),
]);

/** Best-effort: a diagnostics run must never make the connect flow fail harder.
 *  Also mirrored to Workers Logs so the report survives even a D1 hiccup. */
export async function saveVivaDiagnostics(pid: string, report: VivaDiagnostics): Promise<void> {
  console.log(`[viva-diag] ${pid} ${JSON.stringify(report)}`);
  try {
    await ensureSchema();
    await db()
      .prepare(`INSERT OR REPLACE INTO viva_diag (property_id, ts, report) VALUES (?, ?, ?)`)
      .bind(pid, Date.now(), JSON.stringify(report))
      .run();
  } catch (e) {
    console.log(`[viva-diag] persist failed for ${pid}: ${e instanceof Error ? e.message : e}`);
  }
}
