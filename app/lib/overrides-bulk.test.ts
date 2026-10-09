import { describe, expect, it, vi } from "vitest";

// The collection pages used to read overrides + settings with one KV get per
// property (288 gets for 144 properties, queued behind Workers' ~6-subrequest
// limit: ~2 s). The bulk helpers must give the SAME answers as the per-property
// readers, in at most ceil(n/100) KV calls. The fake KV mimics the real bulk
// get: an array in, a Map out, 100 keys at most.

const store = new Map<string, string>();
let bulkCalls = 0;
let singleCalls = 0;
const kv = {
  get: async (k: string | string[]) => {
    if (Array.isArray(k)) {
      bulkCalls++;
      if (k.length > 100) throw new Error("KV bulk get takes at most 100 keys");
      return new Map(k.map((key) => [key, store.get(key) ?? null]));
    }
    singleCalls++;
    return store.get(k) ?? null;
  },
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
};

vi.mock("cloudflare:workers", () => ({ env: { CONFIG_KV: kv }, waitUntil: () => {} }));

describe("bulk property readers", () => {
  it("match getOverrides/getSettings and stay within the 100-key bulk limit", async () => {
    const { getHasGeo, getHotelNames, getOverrides, getSettings } = await import("./overrides.server");
    const ids = Array.from({ length: 250 }, (_, i) => `p${i}`);
    for (const [i, id] of ids.entries()) {
      // A mix of: named, unnamed (empty override map), corrupt JSON, absent.
      if (i % 4 === 0) store.set(`overrides:${id}`, JSON.stringify({ en: { hotelName: `Hotel ${i}` } }));
      if (i % 4 === 1) store.set(`overrides:${id}`, "{}");
      if (i % 4 === 2) store.set(`overrides:${id}`, "not json");
      if (i % 3 === 0) store.set(`settings:${id}`, JSON.stringify({ latitude: 1, longitude: 2 }));
      if (i % 3 === 1) store.set(`settings:${id}`, JSON.stringify({ latitude: 1 }));
    }

    singleCalls = bulkCalls = 0;
    const names = await getHotelNames(ids);
    const geo = await getHasGeo(ids);
    expect(singleCalls).toBe(0);
    expect(bulkCalls).toBe(6); // 250 keys → 3 chunks, twice

    for (const id of ids) {
      expect(names.get(id)).toBe((await getOverrides(id)).hotelName || undefined);
      expect(geo.get(id)).toBe(Boolean((await getSettings(id)).latitude && (await getSettings(id)).longitude));
    }
    expect(names.get("p0")).toBe("Hotel 0");
    expect(geo.get("p0")).toBe(true); // both coordinates
    expect(geo.get("p1")).toBe(false); // latitude only
    expect(geo.get("p2")).toBe(false); // no settings at all
  });

  it("directory fields match the per-property readers", async () => {
    const { getDirectoryFields, getHeroImage, getOverrides, getSettings } = await import("./overrides.server");
    store.set("overrides:d1", JSON.stringify({ en: { hotelName: "Dee", propertyType: "Boutique hotel" } }));
    store.set("settings:d1", JSON.stringify({ addressCity: "Carmarthen", addressCountry: "gb" }));
    store.set("content:d1", JSON.stringify({ en: { search: { heroImage: "/images/x.jpg" } } }));
    const ids = ["d1", "d-missing"];
    singleCalls = bulkCalls = 0;
    const got = await getDirectoryFields(ids);
    expect(singleCalls).toBe(0);
    expect(bulkCalls).toBe(3); // overrides, settings, content — one each
    for (const id of ids) {
      const f = got.get(id)!;
      expect(f.overrides).toEqual(await getOverrides(id));
      expect(f.settings).toEqual(await getSettings(id));
      expect(f.heroImage).toBe(await getHeroImage(id));
    }
    expect(got.get("d1")!.heroImage).toBe("/images/x.jpg");
    expect(got.get("d-missing")).toEqual({ overrides: {}, settings: {}, heroImage: undefined });
  });

  it("last-received times match the single reader, bad values become null", async () => {
    const { getLastAriReceivedAt, getLastAriReceivedAtMany } = await import("./ari/ingest.server");
    store.set("ari:last-received:h1", "1700000000000");
    store.set("ari:last-received:h2", "garbage");
    const ids = ["h1", "h2", "h3"];
    const many = await getLastAriReceivedAtMany(ids);
    for (const id of ids) expect(many.get(id)).toBe(await getLastAriReceivedAt(id));
    expect(many.get("h1")).toBe(1700000000000);
    expect(many.get("h2")).toBeNull();
    expect(many.get("h3")).toBeNull();
  });

  it("does nothing for an empty list", async () => {
    const { getHasGeo, getHotelNames } = await import("./overrides.server");
    bulkCalls = 0;
    expect((await getHotelNames([])).size).toBe(0);
    expect((await getHasGeo([])).size).toBe(0);
    expect(bulkCalls).toBe(0);
  });
});
