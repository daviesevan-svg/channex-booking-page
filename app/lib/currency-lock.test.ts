import { describe, expect, it } from "vitest";

import { currencyChanged, currencyLock, currencyLockMessage } from "./currency-lock";

describe("currencyLock", () => {
  it("locks once any gateway is connected", () => {
    for (const kind of ["stripe", "viva", "iyzico"]) {
      expect(currencyLock(kind).locked).toBe(true);
    }
  });

  it("does not lock a property with no gateway", () => {
    expect(currencyLock(null).locked).toBe(false);
    expect(currencyLock(undefined).locked).toBe(false);
  });

  it("names the gateway so the message can say what to disconnect", () => {
    expect(currencyLockMessage(currencyLock("viva"))).toContain("Viva");
    expect(currencyLockMessage(currencyLock("iyzico"))).toContain("iyzico");
  });
});

describe("currencyChanged", () => {
  it("ignores a save that posts the same currency back", () => {
    // The whole form posts on every save. Treating that as a change would stop
    // a connected property editing anything else on the page.
    expect(currencyChanged("GBP", "GBP")).toBe(false);
    expect(currencyChanged("GBP", "gbp")).toBe(false);
    expect(currencyChanged("GBP", " GBP ")).toBe(false);
  });

  it("catches a real change", () => {
    expect(currencyChanged("GBP", "EUR")).toBe(true);
  });

  it("ignores an absent field rather than reading it as a change", () => {
    // A PATCH that doesn't mention currency isn't changing it.
    expect(currencyChanged("GBP", undefined)).toBe(false);
    expect(currencyChanged("GBP", "")).toBe(false);
  });

  it("does not fire when there is no current currency to move away from", () => {
    expect(currencyChanged(undefined, "EUR")).toBe(false);
  });
});
