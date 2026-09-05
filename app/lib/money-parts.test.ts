import { describe, expect, it } from "vitest";

import { formatMoney, formatMoneyParts } from "./money";

// The split exists so Google's price-accuracy crawler reads a bare number out
// of itemprop="price". Two things must hold for every currency we support: the
// pieces reassemble to exactly what the guest was already being shown, and the
// tagged `value` parses back to the amount.
const CURRENCIES = ["GBP", "USD", "EUR", "JPY", "THB", "TRY", "UGX", "ISK", "KWD", "VND", "AUD", "CHF"];
const AMOUNTS = [0, 9.5, 362.4, 1234.56, 20000, 1_234_567.89];

describe("formatMoneyParts", () => {
  it("reassembles to formatMoney, for every currency and amount", () => {
    for (const currency of CURRENCIES) {
      for (const amount of AMOUNTS) {
        const { before, number, after } = formatMoneyParts(amount, currency);
        expect(`${before}${number}${after}`).toBe(formatMoney(amount, currency));
      }
    }
  });

  it("puts nothing but digits and separators in the visible number", () => {
    for (const currency of CURRENCIES) {
      for (const amount of AMOUNTS) {
        expect(formatMoneyParts(amount, currency).number).toMatch(/^[\d.,  ]+$/);
      }
    }
  });

  it("gives a machine value that parses back to the displayed amount", () => {
    for (const currency of CURRENCIES) {
      for (const amount of AMOUNTS) {
        const { number, value } = formatMoneyParts(amount, currency);
        // Same digits, minus the grouping — never a different number.
        expect(value).toBe(number.replace(/,/g, ""));
        expect(Number(value)).toBeCloseTo(Number(number.replace(/,/g, "")), 5);
      }
    }
  });

  it("splits a symbol-before currency", () => {
    expect(formatMoneyParts(362.4, "GBP")).toEqual({
      before: "£",
      number: "362.40",
      after: "",
      value: "362.40",
    });
  });

  it("keeps a zero-decimal currency whole", () => {
    const { number, value } = formatMoneyParts(20000, "JPY");
    expect(number).toBe("20,000");
    expect(value).toBe("20000");
  });

  it("drops the group separator from the tagged value on a large total", () => {
    const { number, value } = formatMoneyParts(1234.56, "USD");
    expect(number).toBe("1,234.56");
    expect(value).toBe("1234.56");
  });

  it("degrades to the whole formatted string rather than throwing", () => {
    expect(formatMoneyParts("not a number", "GBP").number).toBe("not a number");
  });
});
