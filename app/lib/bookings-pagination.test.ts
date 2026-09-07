import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestD1 } from "./test-d1";
import type { BookingRecord } from "./bookings.server";

const { sqlite, d1 } = makeTestD1();
const prepare = vi.spyOn(d1, "prepare");
vi.mock("cloudflare:workers", () => ({ env: { DB: d1 }, waitUntil: () => {} }));
vi.mock("./api-auth.server", () => ({
  authenticateApiKey: vi.fn(async () => ({ pid: "p1" })),
  apiError: (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status }),
}));
vi.mock("./auth.server", () => ({ requireAdmin: vi.fn(async () => ({})) }));
vi.mock("./properties.server", () => ({ currentPropertyId: vi.fn(async () => "p1") }));

const record = (id: string, patch: Partial<BookingRecord> = {}): BookingRecord => ({
  id, reference: `REF-${id}`.toUpperCase(), status: "confirmed", createdAt: "2026-09-01T10:00:00Z",
  currency: "GBP", checkin: "2026-10-01", checkout: "2026-10-03", nights: 2, total: 100,
  guest: { firstName: "Test", lastName: id, email: `${id}@example.com`, phone: "123" }, rooms: [],
  ...patch,
});
function insert(pid: string, r: BookingRecord) {
  sqlite.prepare("INSERT INTO booking (pid,id,reference,email,created_at,lifecycle,json) VALUES (?,?,?,?,?,?,?)")
    .run(pid, r.id, r.reference, r.guest.email, r.createdAt, r.lifecycle ?? "active", JSON.stringify(r));
}
const req = (path: string) => ({ request: new Request(`https://example.com${path}`) }) as never;

beforeAll(async () => {
  const { getBookings } = await import("./bookings.server");
  await getBookings("p1");
  // Mirrors the versioned ordering-index migration, not request-time DDL.
  sqlite.exec("CREATE INDEX booking_created_at ON booking(pid, created_at)");
});
beforeEach(() => {
  sqlite.exec("DELETE FROM booking");
  insert("p1", record("a"));
  insert("p1", record("b"));
  insert("p1", record("cancelled", { lifecycle: "cancelled", createdAt: "2026-09-02T00:00:00Z" }));
  insert("p1", record("failed", { status: "failed", checkin: "2026-11-01", createdAt: "2026-09-03T23:59:59.999Z" }));
  insert("p2", record("foreign", { createdAt: "2026-09-04T12:00:00Z" }));
  prepare.mockClear();
});

describe("database booking pages", () => {
  it("bounds JSON decoding, retains count and tenant scope, and preserves stable ties", async () => {
    const { getBookingsPage } = await import("./bookings.server");
    // An old JSON payload not in the page must never be fetched or decoded.
    sqlite.prepare("UPDATE booking SET json='invalid JSON' WHERE id='a'").run();
    const first = await getBookingsPage("p1", { limit: 2, offset: 0 });
    expect(first.total).toBe(4);
    expect(first.bookings.map((b) => b.id)).toEqual(["failed", "cancelled"]);
    expect(await getBookingsPage("p1", { limit: 2, offset: 99 })).toEqual({ total: 4, bookings: [] });
    sqlite.prepare("UPDATE booking SET json=? WHERE id='a'").run(JSON.stringify(record("a")));
    const second = await getBookingsPage("p1", { limit: 2, offset: 2 });
    expect(second.bookings.map((b) => b.id)).toEqual(["b", "a"]);
    expect(prepare.mock.calls.some(([sql]) => /SELECT json.*LIMIT \? OFFSET \?/.test(sql))).toBe(true);
    const plan = sqlite.prepare("EXPLAIN QUERY PLAN SELECT json FROM booking WHERE pid=? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?").all("p1", 2, 2);
    expect(JSON.stringify(plan)).toContain("booking_created_at");
    expect(JSON.stringify(plan)).not.toContain("TEMP B-TREE");
  });

  it("filters and counts in SQL, including legacy active records and inclusive date boundaries", async () => {
    const { getBookingsPage } = await import("./bookings.server");
    const active = await getBookingsPage("p1", { limit: 1, offset: 1, status: "confirmed", lifecycle: "active", checkinFrom: "2026-10-01", checkinTo: "2026-10-01", createdFrom: "2026-09-01", createdTo: "2026-09-01" });
    expect(active.total).toBe(2);
    expect(active.bookings.map((b) => b.id)).toEqual(["a"]);
    const late = await getBookingsPage("p1", { limit: 10, offset: 0, createdFrom: "2026-09-03", createdTo: "2026-09-03" });
    expect(late.bookings.map((b) => b.id)).toEqual(["failed"]);
    const injection = await getBookingsPage("p1' OR 1=1 --", { limit: 10, offset: 0 });
    expect(injection).toEqual({ total: 0, bookings: [] });
  });

  it("normalizes reference and isolates the indexed point lookup", async () => {
    const { getBookingByReference } = await import("./bookings.server");
    expect((await getBookingByReference("p1", "  ref-A "))?.id).toBe("a");
    expect(await getBookingByReference("p1", "REF-foreign")).toBeUndefined();
  });

  it("keeps API list contracts, including the management API's equal-date order", async () => {
    const { loader: read } = await import("../routes/api.v1.bookings");
    const { loader: manage } = await import("../routes/api.v1.manage.bookings");
    const response = await read(req("/v1/bookings?limit=2&offset=2"));
    const json = await response.json();
    expect(json).toMatchObject({ total: 4, limit: 2, offset: 2 });
    expect(json.data.map((b: { id: string }) => b.id)).toEqual(["b", "a"]);
    const managed = await manage(req("/v1/manage/bookings?status=confirmed&lifecycle=active&checkin_from=2026-10-01&checkin_to=2026-10-01&created_from=2026-09-01&created_to=2026-09-01&limit=1&offset=0"));
    const mj = await managed.json();
    expect(mj).toMatchObject({ total: 2, limit: 1, offset: 0 });
    expect(mj.data.map((b: { id: string }) => b.id)).toEqual(["a"]);
    expect((await (await read(req("/v1/bookings?limit=500"))).json()).limit).toBe(100);
    expect((await (await manage(req("/v1/manage/bookings?limit=500"))).json()).limit).toBe(200);
  });

  it.each(["limit=0", "limit=-1", "limit=1.5", "offset=-1", "offset=Infinity", "offset=9007199254740992", "limit=2junk"])("rejects malformed paging %s before querying", async (query) => {
    for (const route of ["../routes/api.v1.bookings", "../routes/api.v1.manage.bookings"]) {
      const { loader } = await import(route);
      expect((await loader(req(`/v1/bookings?${query}`))).status).toBe(422);
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it("pages the admin list without changing the total and preserves property query selection", async () => {
    for (let i = 0; i < 51; i++) insert("p1", record(`bulk${i}`));
    const { loader } = await import("../routes/admin/bookings");
    const first = await loader(req("/admin/bookings?property=p1"));
    expect(first).toMatchObject({ configured: true, total: 55, page: 1, previousPage: null, nextPage: "?property=p1&page=2" });
    if (!first.configured) throw Error("not configured");
    expect(first.bookings).toHaveLength(50);
    const second = await loader(req("/admin/bookings?property=p1&page=2"));
    expect(second).toMatchObject({ total: 55, page: 2, previousPage: "?property=p1&page=1", nextPage: null });
    if (!second.configured) throw Error("not configured");
    expect(second.bookings).toHaveLength(5);
    expect(new Set([...first.bookings, ...second.bookings].map((b) => b.id)).size).toBe(55);
  });

  it("redirects stale admin pages to the last page after deletions", async () => {
    const { loader } = await import("../routes/admin/bookings");
    await expect(loader(req("/admin/bookings?property=p1&page=99"))).rejects.toSatisfy((response: Response) =>
      response.status === 302 && response.headers.get("Location") === "?property=p1&page=1");
  });

});
