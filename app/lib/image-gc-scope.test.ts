import { describe, expect, it, vi } from "vitest";

// The GC may only delete what the editing property uploaded. Before this, any
// `/images/…` url a save dropped was a candidate, spared only if some property
// still referenced it — so a room list naming a partner's logo or the Google
// feed snapshot, saved twice, deleted an object that belonged to nobody in the
// scan. Runs the real deleteUnreferencedImages over an in-memory KV and a
// recording R2 bucket; the reference stores that need D1 are stubbed empty.

const store = new Map<string, string>();
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
};
const deleted: string[] = [];
const bucket = { delete: async (key: string) => void deleted.push(key) };

vi.mock("cloudflare:workers", () => ({
  env: { CONFIG_KV: kv, IMAGES: bucket },
  waitUntil: () => {},
}));
vi.mock("./catalog.server", () => ({ getRooms: async () => [] }));
vi.mock("./extras.server", () => ({ getExtras: async () => [] }));
vi.mock("./gallery.server", () => ({ getGallery: async () => ({ images: [] }) }));
vi.mock("./site.server", () => ({ siteImageUrls: async () => [] }));
vi.mock("./vouchers.server", () => ({ getVoucherProducts: async () => [], voucherSnapshotImages: async () => [] }));

store.set(
  "properties",
  JSON.stringify([
    { id: "A", name: "A", owner: "a@example.com" },
    { id: "B", name: "B", owner: "b@example.com" },
  ]),
);

describe("image-paths", () => {
  it("knows which keys a property owns and which urls a payload may reference", async () => {
    const { isPropertyImageUrl, ownsImageKey, propertyImageOwner } = await import("./image-paths");
    expect(propertyImageOwner("gallery/A/1.jpg")).toBe("A");
    expect(propertyImageOwner("catalog/A/room1/1.jpg")).toBe("A");
    expect(propertyImageOwner("partners/P/logo/1.png")).toBeNull();
    expect(propertyImageOwner("feeds/google-hotels-all.xml")).toBeNull();
    expect(propertyImageOwner("gallery/A")).toBeNull();
    expect(ownsImageKey("A", "gallery/A/1.jpg")).toBe(true);
    expect(ownsImageKey("A", "gallery/B/1.jpg")).toBe(false);
    expect(isPropertyImageUrl("/images/gallery/B/1.jpg")).toBe(true); // a clone's source — allowed
    expect(isPropertyImageUrl("/images/partners/P/logo/1.png")).toBe(false);
    expect(isPropertyImageUrl("/images/feeds/google-hotels-all.xml")).toBe(false);
    expect(isPropertyImageUrl("/images/gallery/A/../../partners/P/logo/1.png")).toBe(false);
    expect(isPropertyImageUrl("https://evil.example/x.png")).toBe(false);
  });
});

describe("deleteUnreferencedImages", () => {
  it("deletes only the editing property's own unreferenced keys", async () => {
    const { deleteUnreferencedImages } = await import("./image-gc.server");
    deleted.length = 0;
    await deleteUnreferencedImages("A", [
      "/images/gallery/A/mine.jpg", // A's own orphan → deleted
      "/images/gallery/B/theirs.jpg", // another property's → never
      "/images/partners/P/logo/brand.png", // partner asset → never
      "/images/feeds/google-hotels-all.xml", // feed snapshot → never
      "/images/legacy-no-owner.jpg", // pre-prefix key → never
      "https://cdn.example/pasted.jpg", // not ours at all
    ]);
    expect(deleted).toEqual(["gallery/A/mine.jpg"]);
  });

  it("still spares the property's own key when another property references it", async () => {
    const { deleteUnreferencedImages } = await import("./image-gc.server");
    // B (a clone of A) points at A's upload via its settings.
    store.set("settings:B", JSON.stringify({ coverImage: "/images/cover/A/shared.jpg" }));
    deleted.length = 0;
    await deleteUnreferencedImages("A", ["/images/cover/A/shared.jpg"]);
    expect(deleted).toEqual([]);
  });
});
