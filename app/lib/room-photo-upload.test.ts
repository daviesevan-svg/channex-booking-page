import { beforeEach, describe, expect, it, vi } from "vitest";

// Photos are stored one request at a time now (routes/admin/room-photo.tsx), so
// bytes reach R2 BEFORE the room is saved. That creates an orphan the old
// single-POST save could not: an upload the admin dropped, or replaced, between
// picking it and saving. The uploader keeps declaring every url it stored in
// `stagedImage` precisely so the save can hand what it did not keep to the GC.
//
// This is the one thing local dev cannot show: `fireAndForget` needs a real
// `waitUntil`, so under vite the sweep is dropped at request teardown and the
// object survives — for the pre-existing removal path too, not just this one.
// Here the sweep runs to completion against a recording bucket.

const store = new Map<string, string>();
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
};
const deleted: string[] = [];
const bucket = {
  delete: async (key: string) => void deleted.push(key),
  put: async () => {},
};

vi.mock("cloudflare:workers", () => ({
  env: { CONFIG_KV: kv, IMAGES: bucket },
  // Real, so the fire-and-forget sweep is awaited rather than dropped.
  waitUntil: (work: Promise<unknown>) => void pending.push(work),
}));
const pending: Promise<unknown>[] = [];

vi.mock("./auth.server", () => ({ requireAdmin: async () => "owner@example.com" }));
vi.mock("./properties.server", () => ({
  currentPropertyId: async () => "P1",
  getProperties: async () => [{ id: "P1", name: "P1", owner: "owner@example.com" }],
}));
// Needs D1 / an outbound push; neither is what this file is about.
vi.mock("./google-ari/push.server", () => ({ queueGoogleAriPush: async () => {} }));
vi.mock("./gallery.server", () => ({ getGallery: async () => ({ images: [] }) }));
vi.mock("./site.server", () => ({ siteImageUrls: async () => [] }));
vi.mock("./extras.server", () => ({ getExtras: async () => [] }));
vi.mock("./vouchers.server", () => ({
  getVoucherProducts: async () => [],
  voucherSnapshotImages: async () => [],
}));

const KEPT = "/images/catalog/P1/new/kept-800x600.jpg";
const DROPPED = "/images/catalog/P1/new/dropped-800x600.jpg";

/** The form the editor posts: text fields, the urls it is keeping, and every
 *  url the uploader stored (kept or not). */
function body(fields: Record<string, string>, keep: string[], staged: string[]): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  for (const url of keep) form.append("keepImage", url);
  for (const url of staged) form.append("stagedImage", url);
  return form;
}

async function saveRoomForm(roomId: string, form: FormData) {
  const { action } = await import("../routes/admin/room");
  const request = new Request(`http://localhost/admin/rooms/${roomId}`, { method: "POST", body: form });
  const result = await action({ request, params: { roomId }, context: {} } as never);
  // Drain the sweep the action queued.
  await Promise.all(pending.splice(0));
  return result;
}

describe("a room save after per-file photo uploads", () => {
  beforeEach(() => {
    store.clear();
    deleted.length = 0;
    pending.length = 0;
  });

  it("stores the photos it kept and reclaims the one the admin dropped", async () => {
    await saveRoomForm(
      "new",
      body({ title: "Attic Double", maxAdults: "2", maxGuests: "2" }, [KEPT], [KEPT, DROPPED]),
    );

    const rooms = JSON.parse(store.get("catalog_rooms:P1") ?? "[]");
    expect(rooms).toHaveLength(1);
    expect(rooms[0].images).toEqual([KEPT]);
    // The dropped upload is gone from the bucket; the kept one is untouched.
    expect(deleted).toEqual(["catalog/P1/new/dropped-800x600.jpg"]);
  });

  it("leaves a staged photo alone when it was kept", async () => {
    await saveRoomForm(
      "new",
      body({ title: "Twin", maxAdults: "2", maxGuests: "2" }, [KEPT, DROPPED], [KEPT, DROPPED]),
    );

    const rooms = JSON.parse(store.get("catalog_rooms:P1") ?? "[]");
    expect(rooms[0].images).toEqual([KEPT, DROPPED]);
    expect(deleted).toEqual([]);
  });

  it("still reclaims a photo the room used to have and no longer does", async () => {
    const OLD = "/images/catalog/P1/r1/old-800x600.jpg";
    store.set(
      "catalog_rooms:P1",
      JSON.stringify([
        {
          id: "r1",
          title: "Attic Double",
          images: [OLD, KEPT],
          maxAdults: 2,
          maxGuests: 2,
          facilities: [],
          amenities: [],
          position: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );

    // Unticking "keep" is how an existing photo is removed; no new uploads.
    await saveRoomForm("r1", body({ title: "Attic Double", maxAdults: "2", maxGuests: "2" }, [KEPT], []));

    const rooms = JSON.parse(store.get("catalog_rooms:P1") ?? "[]");
    expect(rooms[0].images).toEqual([KEPT]);
    expect(deleted).toEqual(["catalog/P1/r1/old-800x600.jpg"]);
  });
});
