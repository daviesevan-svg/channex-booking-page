import { describe, expect, it } from "vitest";
import { fromMinor, toMinor } from "./fraction";

// Channex sends fraction_size per rate: 0 for zero-decimal currencies
// (VND/JPY/KRW…), 3 for the mils currencies (BHD…), 2 for most. The regression
// this file pins: a `|| 2` on the decode side treated fraction 0 as 2 and
// showed (and charged) a ₫500,000 rate as ₫5,000.
describe("price_minor round trip", () => {
  it("keeps a zero-decimal rate whole (the VND ÷100 regression)", () => {
    const minor = toMinor("500000", 0);
    expect(minor).toBe(500_000);
    expect(fromMinor(minor, 0)).toBe(500_000);
  });

  it("round-trips two-decimal rates", () => {
    const minor = toMinor("198.00", 2);
    expect(minor).toBe(19_800);
    expect(fromMinor(minor, 2)).toBe(198);
  });

  it("round-trips three-decimal rates", () => {
    const minor = toMinor("12.345", 3);
    expect(minor).toBe(12_345);
    expect(fromMinor(minor, 3)).toBe(12.345);
  });

  it("defaults a missing fraction_size to 2 on both sides", () => {
    expect(toMinor("198.00", undefined)).toBe(19_800);
    expect(toMinor("198.00", null)).toBe(19_800);
    expect(fromMinor(19_800, undefined)).toBe(198);
    expect(fromMinor(19_800, null)).toBe(198);
  });
});
