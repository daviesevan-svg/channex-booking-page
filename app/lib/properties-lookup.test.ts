import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

// Resolving a property is a point lookup, not a scan of every tenant.
//
// resolvePropertyId runs in the layout loader of every guest request. It used
// to SELECT the whole registry and search it in JavaScript, so each hotel's
// page got slower as unrelated hotels were added. This drives the real module
// against a real SQLite database and asserts on the SQL actually issued: the
// hot paths must never read the whole table.
//
// The D1 binding is shimmed onto node:sqlite (D1 IS SQLite), as in
// ari/ingest-roundtrip.test.ts.

const sqlite = new DatabaseSync(":memory:");

/** Every statement the module sent, in order. */
let sql: string[] = [];
/** Statements that read the registry without narrowing it — the thing this
 *  change exists to remove from the hot path. */
const fullReads = () => sql.filter((q) => /SELECT json FROM property\s*$/i.test(q.trim()));
/** Statements that walk every row to answer a yes/no question. The lookup only
 *  needs to know whether the registry has anything in it at all, and COUNT(*)
 *  reads the lot to say so. */
const registryCounts = () => sql.filter((q) => /COUNT\(\s*\*\s*\)\s*FROM property/i.test(q));

type Stmt = { sql: string; args: unknown[]; bind: (...a: unknown[]) => Stmt; first: () => Promise<unknown>; run: () => Promise<unknown>; all: () => Promise<unknown> };
const makeStmt = (query: string): Stmt => ({
  sql: query,
  args: [],
  bind(...a: unknown[]) {
    this.args = a;
    return this;
  },
  async first() {
    sql.push(this.sql);
    return sqlite.prepare(this.sql).get(...(this.args as never[])) ?? null;
  },
  async run() {
    sql.push(this.sql);
    sqlite.prepare(this.sql).run(...(this.args as never[]));
    return { success: true };
  },
  async all() {
    sql.push(this.sql);
    return { results: sqlite.prepare(this.sql).all(...(this.args as never[])) };
  },
});
const fakeD1 = {
  prepare: (query: string) => makeStmt(query),
  batch: async (stmts: Stmt[]) =>
    stmts.map((s) => {
      sql.push(s.sql);
      const p = sqlite.prepare(s.sql);
      if (/^\s*(select|with)/i.test(s.sql)) return { results: p.all(...(s.args as never[])) };
      p.run(...(s.args as never[]));
      return { results: [] };
    }),
};

const kvData: Record<string, string> = {};
const fakeKV = { get: async (k: string) => kvData[k] ?? null, put: async (k: string, v: string) => void (kvData[k] = v) };

vi.mock("cloudflare:workers", () => ({
  env: { DB: fakeD1, CONFIG_KV: fakeKV, DEFAULT_PROPERTY_ID: "" },
  waitUntil: () => {},
}));

const ref = (id: string, slug?: string) => ({ id, name: id, ...(slug ? { slug } : {}) });

async function seed(refs: { id: string; name: string; slug?: string }[]) {
  const { getProperties } = await import("./properties.server");
  await getProperties().catch(() => []); // let the module create its schema
  // Each case owns the registry outright — these tests are about which rows a
  // lookup touches, so a leftover row from a neighbour changes the answer.
  sqlite.prepare(`DELETE FROM property`).run();
  for (const r of refs) {
    sqlite.prepare(`INSERT OR REPLACE INTO property (id, json) VALUES (?, ?)`).run(r.id, JSON.stringify(r));
  }
}

describe("property resolution", () => {
  it("maps a slug to its id without reading the registry", async () => {
    await seed([ref("uuid-a", "spilmanhotel"), ref("uuid-b", "othertown"), ref("uuid-c")]);
    const { resolvePropertyId } = await import("./properties.server");

    sql = [];
    await expect(resolvePropertyId("spilmanhotel")).resolves.toBe("uuid-a");
    expect(fullReads()).toEqual([]);
  });

  it("lets an id win over another property's slug, as it always has", async () => {
    await seed([ref("uuid-a", "spilmanhotel"), ref("spilmanhotel", "elsewhere")]);
    const { resolvePropertyId } = await import("./properties.server");
    // The id match must win, or the newcomer captures the other's guest URL.
    await expect(resolvePropertyId("spilmanhotel")).resolves.toBe("spilmanhotel");
  });

  it("is case-insensitive on the slug, like the old scan", async () => {
    await seed([ref("uuid-a", "spilmanhotel")]);
    const { resolvePropertyId } = await import("./properties.server");
    await expect(resolvePropertyId("SpilmanHotel")).resolves.toBe("uuid-a");
  });

  it("returns an unknown segment unchanged, still without a full read", async () => {
    await seed([ref("uuid-a", "spilmanhotel")]);
    const { resolvePropertyId } = await import("./properties.server");

    sql = [];
    await expect(resolvePropertyId("no-such-hotel")).resolves.toBe("no-such-hotel");
    // A miss against a populated registry is an answer, not a reason to go and
    // read all of it.
    expect(fullReads()).toEqual([]);
  });

  it("fetches one property by id without the registry", async () => {
    await seed([ref("uuid-a", "spilmanhotel"), ref("uuid-b", "othertown")]);
    const { getProperty } = await import("./properties.server");

    sql = [];
    await expect(getProperty("uuid-b")).resolves.toMatchObject({ id: "uuid-b", slug: "othertown" });
    expect(fullReads()).toEqual([]);
  });

  it("tells an empty registry from a miss without counting the registry", async () => {
    await seed([ref("uuid-a", "spilmanhotel"), ref("uuid-b", "othertown")]);
    const { resolvePropertyId } = await import("./properties.server");

    sql = [];
    await expect(resolvePropertyId("othertown")).resolves.toBe("uuid-b");
    expect(registryCounts()).toEqual([]);
    expect(fullReads()).toEqual([]);
  });

  it("still defers to the full read when the registry really is empty", async () => {
    await seed([]);
    const { getProperty } = await import("./properties.server");

    sql = [];
    // Nothing to have missed, so the seed-on-first-run path has to get a look.
    await expect(getProperty("uuid-a")).resolves.toBeUndefined();
    expect(fullReads().length).toBeGreaterThan(0);
  });

  it("keeps the slug in step with the stored json, with nothing on the write path to remember", async () => {
    await seed([ref("uuid-a", "spilmanhotel")]);
    const { resolvePropertyId } = await import("./properties.server");
    await expect(resolvePropertyId("spilmanhotel")).resolves.toBe("uuid-a");

    // Rewrite the row's json alone — the generated column has to follow.
    sqlite.prepare(`UPDATE property SET json = ? WHERE id = ?`).run(JSON.stringify(ref("uuid-a", "renamed")), "uuid-a");
    await expect(resolvePropertyId("renamed")).resolves.toBe("uuid-a");
    await expect(resolvePropertyId("spilmanhotel")).resolves.toBe("spilmanhotel");
  });
});
