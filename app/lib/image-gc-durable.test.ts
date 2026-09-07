import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestD1, seedProperties } from "./test-d1";

const { sqlite, d1 } = makeTestD1();
const refs = new Map<string, string[]>();
const hidden = new Map<string, string[]>();
const sold = new Map<string, string[]>();
const deleted: string[] = [];
const failReads = new Set<string>();
let failDelete = false;
let duringDelete: (() => Promise<void>) | undefined;
const bucket = { delete: async (key: string) => {
  await duringDelete?.();
  if (failDelete) throw new Error("R2 temporarily unavailable");
  deleted.push(key);
} };
const store = new Map<string, string>();
vi.mock("cloudflare:workers", () => ({ env: { DB: d1, IMAGES: bucket, CONFIG_KV: {
  get: async (k: string) => {
    const [prefix, pid] = k.split(":");
    if (prefix === "gallery" && failReads.has(pid)) throw new Error("KV temporarily unavailable");
    if (store.has(k)) return store.get(k)!;
    if (prefix === "gallery" && refs.has(pid)) return JSON.stringify({ images: refs.get(pid)!.map((url) => ({ url })) });
    if (prefix === "site" && hidden.has(pid)) return JSON.stringify({ hidden: hidden.get(pid) });
    return null;
  },
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
  list: async ({ prefix, cursor, limit }: { prefix: string; cursor?: string; limit: number }) => {
    const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
    const offset = Number(cursor || 0);
    const page = keys.slice(offset, offset + limit).map((name) => ({ name }));
    return { keys: page, list_complete: offset + limit >= keys.length, cursor: String(offset + limit) };
  },
} }, waitUntil: () => {} }));
vi.mock("./catalog.server", () => ({ getRooms: async () => [] }));
vi.mock("./extras.server", () => ({ getExtras: async () => [] }));
vi.mock("./gallery.server", () => ({ getGallery: async (pid: string) => {
  if (failReads.has(pid)) throw new Error("KV temporarily unavailable");
  return { images: (refs.get(pid) ?? []).map((url) => ({ url })) };
} }));
vi.mock("./site.server", () => ({ siteImageUrls: async (pid: string) => hidden.get(pid) ?? [] }));
vi.mock("./vouchers.server", () => ({ getVoucherProducts: async () => [], voucherSnapshotImages: async (pid: string) => sold.get(pid) ?? [] }));

const gc = await import("./image-gc.server");
const coordination = await import("./image-gc-store.server");
const config = await import("./config.server");
const key = "gallery/A/photo.jpg";
const url = `/images/${key}`;
let now = 2_000_000_000_000;
const advanceGrace = () => { now += coordination.IMAGE_GC_GRACE_MS + 1; };
const candidates = () => sqlite.prepare("SELECT * FROM image_gc_candidate").all();

beforeEach(async () => {
  vi.restoreAllMocks();
  now = 2_000_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await coordination.ensureImageGcSchema();
  for (const table of ["image_gc_candidate", "image_gc_property", "image_gc_write", "image_gc_scan", "image_gc_seen", "image_gc_deleted", "image_gc_pin"]) sqlite.exec(`DELETE FROM ${table}`);
  sqlite.exec("UPDATE image_gc_state SET processor_token=NULL, processor_until=0, deleting_key=NULL");
  sqlite.exec("UPDATE image_gc_bootstrap SET cursor=NULL,complete=0");
  seedProperties(sqlite, []);
  sqlite.exec("DELETE FROM property");
  seedProperties(sqlite, [{ id: "A", name: "A" }]);
  refs.clear(); hidden.clear(); sold.clear(); store.clear(); failReads.clear(); deleted.length = 0;
  failDelete = false;
  duringDelete = undefined;
});

describe("durable image cleanup", () => {
  it("waits for grace, then resumes a 103-property scan across bounded ticks", async () => {
    seedProperties(sqlite, Array.from({ length: 102 }, (_, i) => ({ id: `P${String(i).padStart(3, "0")}` })));
    await gc.deleteUnreferencedImages("A", [url]);
    expect((await gc.processImageCleanup()).scannedProperties).toBe(0);
    expect(deleted).toEqual([]);
    advanceGrace();
    for (let i = 0; i < 4; i++) {
      const step = await gc.processImageCleanup({ propertyLimit: 25 });
      expect(step.scannedProperties).toBe(25);
      expect(deleted).toEqual([]);
    }
    expect((await gc.processImageCleanup({ propertyLimit: 25 })).scannedProperties).toBe(3);
    expect(deleted).toEqual([key]);
    expect(candidates()).toHaveLength(0);
  });

  it("bootstraps removed legacy clone IDs in bounded pages before deletion", async () => {
    for (let i = 0; i < 101; i++) store.set(`property_tombstone:old${String(i).padStart(3, "0")}`, "{}");
    refs.set("old100", [url]);
    await gc.deleteUnreferencedImages("A", [url]);
    advanceGrace();
    expect((await gc.processImageCleanup()).scannedProperties).toBe(0); // first 100 tombstones only
    expect(deleted).toEqual([]);
    for (let i = 0; i < 3; i++) await gc.processImageCleanup();
    expect(deleted).toEqual([]);
    expect(candidates()).toHaveLength(1);
    expect(sqlite.prepare("SELECT complete FROM image_gc_bootstrap").get()?.complete).toBe(1);
  });

  it("pins new references while KV is stale, without requiring a quiet day", async () => {
    await gc.deleteUnreferencedImages("A", [url]);
    advanceGrace();
    // Simulate a successful put whose value has not propagated to reads yet.
    await coordination.withImageReferenceWrite("B", { image: url }, async () => {});
    expect((await gc.processImageCleanup()).retainedImages).toBe(1);
    expect(deleted).toEqual([]);
  });

  it("can delete an unrelated orphan while other image content is being edited daily", async () => {
    await gc.deleteUnreferencedImages("A", [url]);
    advanceGrace();
    await coordination.withImageReferenceWrite("B", { image: "/images/gallery/B/keep.jpg" }, async () => {});
    expect((await gc.processImageCleanup()).deletedImages).toBe(1);
    expect(deleted).toEqual([key]);
  });

  it("invalidates cached scan evidence when pins expire during a long batch", async () => {
    seedProperties(sqlite, [{ id: "B" }, { id: "C" }]);
    await gc.deleteUnreferencedImages("A", [url]);
    advanceGrace();
    await coordination.withImageReferenceWrite("A", { image: url }, async () => {});
    await gc.processImageCleanup({ propertyLimit: 1 }); // A is scanned while its KV read is stale
    expect(sqlite.prepare("SELECT COUNT(*) n FROM image_gc_seen").get()?.n).toBe(1);
    refs.set("A", [url]); // the persisted write becomes visible before its pin expires
    advanceGrace();
    advanceGrace();
    const step = await gc.processImageCleanup();
    expect(step.scannedProperties).toBe(3); // A was invalidated, B/C were not yet scanned
    expect(step.retainedImages).toBe(1);
    expect(deleted).toEqual([]);
  });

  it("keeps a reference found on the final property of a large scan", async () => {
    seedProperties(sqlite, Array.from({ length: 102 }, (_, i) => ({ id: `P${String(i).padStart(3, "0")}` })));
    refs.set("P101", [url]);
    await gc.deleteUnreferencedImages("A", [url]);
    advanceGrace();
    for (let i = 0; i < 3; i++) await gc.processImageCleanup();
    expect(deleted).toEqual([]);
    expect(candidates()).toHaveLength(1); // may become orphaned after clone removal
  });

  it("preserves absolute and resized references to the same object", async () => {
    seedProperties(sqlite, [{ id: "B" }]);
    refs.set("B", ["https://book.roompanda.com/images/gallery/A/photo.jpg?w=400#preview"]);
    sold.set("B", ["/images/gallery/A/sold.jpg?w=800"]);
    await gc.deleteUnreferencedImages("A", [url, "/images/gallery/A/sold.jpg"]);
    advanceGrace();
    expect((await gc.processImageCleanup()).retainedImages).toBe(2);
    expect(deleted).toEqual([]);
  });

  it("preserves hidden content and sold-voucher snapshots", async () => {
    hidden.set("A", [url]);
    sold.set("A", ["/images/gallery/A/sold.jpg"]);
    await gc.deleteUnreferencedImages("A", [url, "/images/gallery/A/sold.jpg"]);
    advanceGrace();
    expect((await gc.processImageCleanup()).retainedImages).toBe(2);
    expect(deleted).toEqual([]);
  });

  it("rescans an already-visited property changed between slices, including an unregistered clone", async () => {
    seedProperties(sqlite, [{ id: "B" }]);
    await gc.deleteUnreferencedImages("A", [url]);
    advanceGrace();
    await gc.processImageCleanup({ propertyLimit: 1 });
    await coordination.withImageReferenceWrite("A", { image: url }, async () => { refs.set("A", [url]); });
    await coordination.withImageReferenceWrite("new-clone", { image: url }, async () => { refs.set("new-clone", [url]); });
    const step = await gc.processImageCleanup();
    expect(deleted).toEqual([]);
    expect(step.scannedProperties).toBe(3);
    expect(step.retainedImages).toBe(1);
    expect(deleted).toEqual([]);
  });

  it("retries a failed source read without marking the incomplete scan safe", async () => {
    seedProperties(sqlite, [{ id: "B" }]);
    failReads.add("B");
    await gc.deleteUnreferencedImages("A", [url]);
    advanceGrace();
    await expect(gc.processImageCleanup()).rejects.toThrow("KV temporarily unavailable");
    expect(deleted).toEqual([]);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM image_gc_scan").get()?.n).toBe(1);
    failReads.clear();
    expect((await gc.processImageCleanup()).scannedProperties).toBe(1);
    expect(deleted).toEqual([key]);
  });

  it("persists failed R2 deletion and retries after backoff", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await gc.deleteUnreferencedImages("A", [url]);
    advanceGrace();
    failDelete = true;
    await gc.processImageCleanup();
    expect(candidates()[0].attempts).toBe(1);
    expect(deleted).toEqual([]);
    failDelete = false;
    now += coordination.IMAGE_GC_RETRY_MS + 1;
    await gc.processImageCleanup();
    expect(deleted).toEqual([key]);
    expect(candidates()).toHaveLength(0);
  });

  it("blocks a re-add during deletion and rejects stale references afterward", async () => {
    let wrote = false;
    duringDelete = async () => {
      await expect(coordination.withImageReferenceWrite("A", { image: url }, async () => { wrote = true; })).rejects.toThrow("removed from storage");
    };
    await gc.deleteUnreferencedImages("A", [url]);
    advanceGrace();
    await gc.processImageCleanup();
    expect(deleted).toEqual([key]);
    await expect(coordination.withImageReferenceWrite("A", { image: url }, async () => { wrote = true; })).rejects.toThrow("removed from storage");
    await expect(coordination.withImageReferenceWrite("B", { image: `https://hotel.example${url}?w=400` }, async () => { wrote = true; })).rejects.toThrow("removed from storage");
    expect(wrote).toBe(false);
  });

  it("lets unrelated content writes proceed during R2 deletion", async () => {
    let wrote = false;
    duringDelete = () => coordination.withImageReferenceWrite("B", { image: "/images/gallery/B/live.jpg" }, async () => { wrote = true; });
    await gc.deleteUnreferencedImages("A", [url]);
    advanceGrace();
    await gc.processImageCleanup();
    expect(deleted).toEqual([key]);
    expect(wrote).toBe(true);
  });

  it("fails closed on corrupt content and resumes once it can be read", async () => {
    store.set("site:A", "invalid json");
    await gc.deleteUnreferencedImages("A", [url]);
    advanceGrace();
    await expect(gc.processImageCleanup()).rejects.toThrow();
    expect(deleted).toEqual([]);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM image_gc_scan").get()?.n).toBe(0);
    store.delete("site:A");
    await gc.processImageCleanup();
    expect(deleted).toEqual([key]);
  });

  it("recovers an interrupted deletion before allowing reference writes", async () => {
    await gc.deleteUnreferencedImages("A", [url]);
    sqlite.prepare("INSERT INTO image_gc_deleted VALUES (?,?)").run(key, now);
    sqlite.prepare("UPDATE image_gc_state SET deleting_key=? WHERE id=1").run(key);
    await gc.processImageCleanup();
    expect(deleted).toEqual([key]);
    expect(sqlite.prepare("SELECT deleting_key FROM image_gc_state").get()?.deleting_key).toBeNull();
    expect(candidates()).toHaveLength(0);
  });

  it("holds deletion while a reference write is in flight", async () => {
    let complete!: () => void;
    const writing = coordination.withImageReferenceWrite("A", { image: url }, () => new Promise<void>((resolve) => {
      complete = () => { refs.set("A", [url]); resolve(); };
    }));
    // Wait for the actual write callback, without advancing the wall clock.
    while (!complete) await Promise.resolve();
    await gc.deleteUnreferencedImages("A", [url]);
    advanceGrace();
    await gc.processImageCleanup();
    expect(deleted).toEqual([]);
    complete();
    await writing;
    advanceGrace();
    await gc.processImageCleanup();
    expect(deleted).toEqual([]);
  });

  it("does not shorten an unfinished concurrent writer's same-image pin", async () => {
    let finishA!: () => void;
    let finishB!: () => void;
    const a = coordination.withImageReferenceWrite("A", { image: url }, () => new Promise<void>((resolve) => { finishA = resolve; }));
    while (!finishA) await Promise.resolve();
    now += 3600_000;
    const b = coordination.withImageReferenceWrite("A", { image: url }, () => new Promise<void>((resolve) => { finishB = resolve; }));
    while (!finishB) await Promise.resolve();
    const expected = now + 2 * coordination.IMAGE_GC_GRACE_MS;
    finishA();
    await a;
    expect(sqlite.prepare("SELECT expires_at FROM image_gc_pin WHERE pid='A'").get()?.expires_at).toBe(expected);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM image_gc_write").get()?.n).toBe(1);
    finishB();
    await b;
  });

  it("tracks KV writes even outside a request cache and releases failed write leases", async () => {
    await config.getConfigKV().put("gallery:unregistered", JSON.stringify({ images: [{ url }] }));
    expect(sqlite.prepare("SELECT revision FROM image_gc_property WHERE pid='unregistered'").get()?.revision).toBe(2);
    await expect(coordination.withImageReferenceWrite("A", {}, async () => { throw new Error("write failed"); })).rejects.toThrow("write failed");
    expect(sqlite.prepare("SELECT COUNT(*) n FROM image_gc_write").get()?.n).toBe(0);
    expect(coordination.imageReferenceProperty("google_ari_sync:A")).toBeUndefined();
  });
});
