import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestD1, seedProperties } from "./test-d1";

// The registry used to be one KV value that every write rewrote whole, so a
// teammate removal at one hotel could be silently reverted by an unrelated
// rename at another. These run the real mutations against a real database.
const { d1: testD1, sqlite } = makeTestD1();
const store = new Map<string, string>();
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
};
vi.mock("cloudflare:workers", () => ({ env: { DB: testD1, CONFIG_KV: kv }, waitUntil: () => {} }));

const { addPropertyMember, getProperty, removePropertyMember, renameProperty, setPropertyOwner } =
  await import("./properties.server");

beforeEach(() => {
  store.clear();
  sqlite.prepare(`DROP TABLE IF EXISTS property`).run();
  seedProperties(sqlite, [
    { id: "a", name: "Hotel A", owner: "a@example.com", members: ["keep@a.com", "gone@a.com"] },
    { id: "b", name: "Hotel B", owner: "b@example.com", members: ["keep@b.com"] },
  ]);
});

describe("concurrent writes to different properties", () => {
  it("do not revert each other", async () => {
    // The exact shape of the bug: a security-relevant change at one property
    // and an ordinary edit at another, overlapping.
    await Promise.all([removePropertyMember("a", "gone@a.com"), renameProperty("b", "Hotel B renamed")]);

    expect((await getProperty("a"))?.members).toEqual(["keep@a.com"]);
    expect((await getProperty("b"))?.name).toBe("Hotel B renamed");
  });

  it("do not revert each other when it is an ownership transfer", async () => {
    await Promise.all([setPropertyOwner("a", "new@example.com"), addPropertyMember("b", "extra@b.com")]);

    expect((await getProperty("a"))?.owner).toBe("new@example.com");
    expect((await getProperty("b"))?.members).toContain("extra@b.com");
  });

  it("survives many at once", async () => {
    seedProperties(
      sqlite,
      Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, members: ["x@example.com"] })),
    );
    await Promise.all(Array.from({ length: 12 }, (_, i) => removePropertyMember(`p${i}`, "x@example.com")));

    for (let i = 0; i < 12; i++) {
      expect((await getProperty(`p${i}`))?.members).toEqual([]);
    }
  });
});

describe("the KV snapshot", () => {
  it("is refreshed on every write, because partners.server reads it directly", () => {
    // partnerForProperty() cannot import properties.server (import cycle) and
    // reads the "properties" KV value itself. That value is derived now, so if
    // it ever stops being refreshed, partner resolution — sending domains,
    // guest hosts — silently goes stale. This is the tripwire for that.
    return renameProperty("a", "Renamed").then(() => {
      const snap = JSON.parse(store.get("properties")!) as Array<{ id: string; name: string }>;
      expect(snap.find((p) => p.id === "a")?.name).toBe("Renamed");
      expect(snap.find((p) => p.id === "b")).toBeTruthy();
    });
  });
});

describe("what is NOT yet guaranteed", () => {
  it("two edits to the SAME property still last-writer-wins", async () => {
    // Documented, not desired: each mutation still reads the whole record,
    // changes a field and writes the record back, so overlapping edits to one
    // property can drop one of the two fields. Cross-property clobber — every
    // write in the system contending on one key — is what this change removes.
    // Closing this needs a version column and a compare-and-swap retry.
    await Promise.all([setPropertyOwner("a", "owner2@example.com"), renameProperty("a", "Renamed A")]);

    const a = await getProperty("a");
    // What IS guaranteed: the record survives whole — one writer's field may be
    // lost, but the row is never corrupted or emptied, and the rest of it (here
    // the member list) is untouched by either writer.
    expect(a?.id).toBe("a");
    expect(a?.members).toEqual(["keep@a.com", "gone@a.com"]);
    // And at least one of the two edits landed.
    expect(a?.owner === "owner2@example.com" || a?.name === "Renamed A").toBe(true);
  });
});

describe("migration off the single KV key", () => {
  it("imports the legacy registry on first read, once", async () => {
    // Empty the table rather than dropping it: schemaOnce is a per-isolate
    // latch, so a dropped table is never re-created within one test run.
    // Migration triggers on "no rows", which is what this produces.
    sqlite.prepare(`CREATE TABLE IF NOT EXISTS property (id TEXT PRIMARY KEY, json TEXT NOT NULL)`).run();
    sqlite.prepare(`DELETE FROM property`).run();
    store.set(
      "properties",
      JSON.stringify([
        { id: "legacy1", name: "Legacy One", owner: "o@example.com", members: ["m@example.com"] },
        { id: "legacy2", name: "Legacy Two", slug: "legacy-two" },
      ]),
    );

    expect((await getProperty("legacy1"))?.members).toEqual(["m@example.com"]);
    expect((await getProperty("legacy2"))?.slug).toBe("legacy-two");

    // Migrated rows are now the truth: a later write to one must not resurrect
    // the other from the snapshot, and re-reading must not double-insert.
    await renameProperty("legacy1", "Renamed");
    const rows = sqlite.prepare(`SELECT id FROM property`).all() as { id: string }[];
    expect(rows.map((r) => r.id).sort()).toEqual(["legacy1", "legacy2"]);
    expect((await getProperty("legacy1"))?.name).toBe("Renamed");
  });
});

describe("the per-request read cache", () => {
  it("does not serve a stale registry after a write in the same request", async () => {
    // The cache exists so the hot path is one SELECT per request, but an action
    // that writes and then re-reads (every mutation does, to refresh the
    // snapshot) must see its own write — the same read-your-own-writes rule the
    // KV cache follows.
    const { runWithRequestCache } = await import("./request-cache.server");
    await runWithRequestCache(async () => {
      expect((await getProperty("a"))?.name).toBe("Hotel A");
      await renameProperty("a", "Changed Within Request");
      expect((await getProperty("a"))?.name).toBe("Changed Within Request");
    });
  });
});
