// A real SQLite database behind the D1 interface, for tests.
//
// Extracted from refund-once.test.ts, where it was written to pin refund
// once-only semantics against an engine that actually enforces them rather
// than a hand-rolled mock that agrees with whatever the code does. The
// property registry needs the same thing for the same reason — "one writer
// per row" is a claim about the database, not about our code — and three
// management-API tests need it simply because the registry now has rows.
//
// Not a .server module: tests import it directly, and it must never be
// reachable from the app bundle.
import { DatabaseSync } from "node:sqlite";

type Stmt = {
  sql: string;
  args: unknown[];
  bind: (...a: unknown[]) => Stmt;
  run: () => Promise<unknown>;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
};

/** A fresh in-memory database and a D1-shaped handle onto it. */
export function makeTestD1() {
  const sqlite = new DatabaseSync(":memory:");
  const makeStmt = (sql: string): Stmt => ({
    sql,
    args: [],
    bind(...a: unknown[]) {
      this.args = a;
      return this;
    },
    async run() {
      const info = sqlite.prepare(this.sql).run(...(this.args as never[]));
      return { success: true, meta: { changes: Number(info.changes) } };
    },
    async first<T>() {
      return (sqlite.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null;
    },
    async all<T>() {
      return { results: sqlite.prepare(this.sql).all(...(this.args as never[])) as T[] };
    },
  });
  return {
    sqlite,
    d1: {
      prepare: (sql: string) => makeStmt(sql),
      batch: async (stmts: Stmt[]) =>
        stmts.map((s) => {
          const p = sqlite.prepare(s.sql);
          if (/^\s*(select|with)/i.test(s.sql)) return { results: p.all(...(s.args as never[])) };
          const info = p.run(...(s.args as never[]));
          return { results: [], meta: { changes: Number(info.changes) } };
        }),
    },
  };
}

/** Put properties straight into the registry table.
 *
 * Tests used to seed the registry by writing the legacy `properties` KV value.
 * That is no longer where the registry lives, so a test doing it is asserting
 * against a snapshot nothing reads back — seed the rows instead.
 */
export function seedProperties(
  sqlite: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } },
  refs: Array<Record<string, unknown> & { id: string }>,
): void {
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS property (id TEXT PRIMARY KEY, json TEXT NOT NULL)`).run();
  for (const r of refs) {
    sqlite
      .prepare(`INSERT INTO property (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json`)
      .run(r.id, JSON.stringify(r));
  }
}

/** Remove a property from the registry table, as deletion does. */
export function dropProperty(
  sqlite: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } },
  id: string,
): void {
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS property (id TEXT PRIMARY KEY, json TEXT NOT NULL)`).run();
  sqlite.prepare(`DELETE FROM property WHERE id=?`).run(id);
}
