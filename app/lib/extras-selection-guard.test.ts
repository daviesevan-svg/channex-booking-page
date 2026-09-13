import { describe, expect, it, vi } from "vitest";

// The booking API's per-selection guard: the hosted checkout silently clamps an
// over-limit quantity, but an API client must be told, or a pet fee sent with
// qty 3 would quietly be charged once and the client's own total would be wrong.

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: () => {},
}));

import type { Extra } from "./extras";

const petFee = {
  id: "pet",
  name: "Pet fee",
  unit: "night",
  maxQty: 1,
  scope: "booking",
  active: true,
  options: [
    { id: "one", name: "1 pet", price: 35 },
    { id: "two", name: "2 pets", price: 70 },
  ],
} as unknown as Extra;
const tank = { id: "tank", name: "Propane tank", unit: "item", price: 35, scope: "booking", active: true } as unknown as Extra;
const towels = { id: "towels", name: "Beach towels", unit: "stay", price: 5, maxQty: 4, scope: "booking", active: true } as unknown as Extra;

describe("POST /v1/bookings extras selection guard", () => {
  it("rejects a quantity above the extra's limit and accepts everything at or under it", async () => {
    const { extraSelectionError } = await import("../routes/api.v1.bookings");
    const ctx = { scope: "booking" as const };
    expect(extraSelectionError([petFee], { extra_id: "pet", option_id: "two", qty: 2 }, ctx)).toMatch(/charged exactly once/);
    expect(extraSelectionError([petFee], { extra_id: "pet", option_id: "two", qty: 1 }, ctx)).toBeNull();
    expect(extraSelectionError([petFee], { extra_id: "pet", option_id: "two" }, ctx)).toBeNull();
    expect(extraSelectionError([towels], { extra_id: "towels", qty: 5 }, ctx)).toMatch(/at most 4/);
    expect(extraSelectionError([towels], { extra_id: "towels", qty: 4 }, ctx)).toBeNull();
    expect(extraSelectionError([tank], { extra_id: "tank", qty: 12 }, ctx)).toBeNull(); // tanks are per tank
  });
});
