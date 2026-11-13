import { describe, expect, it } from "vitest";

// A Channex import stores each room's base price as 0 ("priced by the channel
// manager"). The rate editor used to drop every non-positive price, so ANY save
// of an imported rate — e.g. switching it to full prepayment — failed with
// "Enter a nightly price for at least one room".
import { parseRoomPrices } from "./rate-prices";
import { validateRateInput } from "./manage-validate";

const form = (fields: Record<string, string>) => (name: string) => fields[name] ?? null;

describe("parseRoomPrices (rate editor)", () => {
  it("keeps 0 — the room is offered and priced from the channel manager", () => {
    expect(parseRoomPrices(form({ "price:a": "0", "price:b": "0" }), ["a", "b"])).toEqual({ a: 0, b: 0 });
  });

  it("blank leaves the room out; positive prices round to cents", () => {
    expect(parseRoomPrices(form({ "price:a": "", "price:b": "99.999" }), ["a", "b", "c"])).toEqual({ b: 100 });
  });

  it("drops negative and non-numeric input", () => {
    expect(parseRoomPrices(form({ "price:a": "-5", "price:b": "abc" }), ["a", "b"])).toEqual({});
  });
});

describe("validateRateInput: prices (management API)", () => {
  const opts = { create: false, roomIds: new Set(["room1", "room2"]) };
  const errorsOf = (r: ReturnType<typeof validateRateInput>) => (r.ok ? {} : r.errors);

  it("accepts 0 for a channel-manager-priced room", () => {
    const r = validateRateInput({ prices: { room1: 0, room2: 120 } }, opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.prices).toEqual({ room1: 0, room2: 120 });
  });

  it("still rejects a negative price", () => {
    expect(errorsOf(validateRateInput({ prices: { room1: -1 } }, opts)).prices?.[0]).toMatch(/≥ 0/);
  });

  it("still requires at least one room", () => {
    expect(errorsOf(validateRateInput({ prices: {} }, opts)).prices?.[0]).toMatch(/At least one room/);
  });
});
