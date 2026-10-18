import { describe, expect, it } from "vitest";

import { inventoryLeaveBlocked } from "./inventory-guard";

const here = { pathname: "/admin/inventory", search: "?start=2026-10-01" };

describe("inventoryLeaveBlocked", () => {
  it("lets a save through: same URL, even with edits pending", () => {
    expect(inventoryLeaveBlocked(4, here, here)).toBe(false);
  });

  it("blocks a sidebar click or a date change while edits are pending", () => {
    expect(inventoryLeaveBlocked(1, here, { pathname: "/admin/bookings", search: "" })).toBe(true);
    expect(inventoryLeaveBlocked(1, here, { pathname: here.pathname, search: "?start=2026-10-15" })).toBe(true);
  });

  it("releases once nothing is dirty", () => {
    expect(inventoryLeaveBlocked(0, here, { pathname: "/admin", search: "" })).toBe(false);
  });
});
