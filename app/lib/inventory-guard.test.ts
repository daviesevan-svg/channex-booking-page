import { describe, expect, it } from "vitest";

import { inventoryLeaveBlocked, nextInventoryFormEpoch } from "./inventory-guard";

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

describe("nextInventoryFormEpoch", () => {
  it("remounts the grid once per successful save", () => {
    const save = { ok: true as const };
    const first = nextInventoryFormEpoch(0, null, save);
    expect(first).toEqual({ epoch: 1, seen: save });
    expect(nextInventoryFormEpoch(first.epoch, first.seen, save)).toEqual(first);
  });

  it("does not remount on a failed save or when nothing was submitted", () => {
    expect(nextInventoryFormEpoch(3, null, { ok: false })).toEqual({ epoch: 3, seen: null });
    expect(nextInventoryFormEpoch(3, null, undefined)).toEqual({ epoch: 3, seen: null });
  });
});
