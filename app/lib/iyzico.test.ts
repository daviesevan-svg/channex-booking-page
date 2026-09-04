import { describe, expect, it } from "vitest";

import {
  IYZICO_CURRENCIES,
  IyzicoError,
  authorizationHeader,
  initializeCheckoutForm,
  iyzicoConfigured,
  iyzicoLocale,
  iyzicoPaid,
  signatureAmount,
  toIyzicoAmount,
} from "./iyzico.server";

// The signing is pinned against vectors computed independently (node:crypto,
// straight from iyzico's documented algorithm) rather than by re-running this
// module's own code — a test that recomputes what it is testing proves the
// function is deterministic, not that it is right. A wrong signature is a flat
// 401 with no clue which of the three components moved, so the order of the
// concatenation is the thing worth nailing down.

const config = { apiKey: "sandbox-key", secretKey: "sandbox-secret", sandbox: true };

describe("the request signature (IYZWSv2)", () => {
  it("signs randomKey + path + body, hex, in that order", async () => {
    const header = await authorizationHeader(
      config,
      "/payment/iyzipos/checkoutform/initialize/auth/ecom",
      JSON.stringify({ locale: "en", price: "100.00" }),
      "1700000000000123456789",
    );
    expect(header).toBe(
      "IYZWSv2 YXBpS2V5OnNhbmRib3gta2V5JnJhbmRvbUtleToxNzAwMDAwMDAwMDAwMTIzNDU2Nzg5JnNpZ25hdHVyZTpkYTA4NTE4MTU4NGVlYmUwMDIxNjExOTVkYWNmNzE0N2I2MzZhODNmODE0ZWYzNTY5NjRiY2YyZjM2NTkzMmU3",
    );
  });

  it("carries the api key and random key in the clear, as iyzico expects", async () => {
    const header = await authorizationHeader(config, "/x", "{}", "rnd-1");
    const decoded = atob(header.replace("IYZWSv2 ", ""));
    expect(decoded).toMatch(/^apiKey:sandbox-key&randomKey:rnd-1&signature:[0-9a-f]{64}$/);
  });

  it("signs the path alone when there is no body", async () => {
    const withBody = await authorizationHeader(config, "/x", "", "rnd-1");
    const without = await authorizationHeader(config, "/x", undefined, "rnd-1");
    expect(without).toBe(withBody);
  });
});

describe("amounts", () => {
  it("sends two decimals", () => {
    expect(toIyzicoAmount(100)).toBe("100.00");
    expect(toIyzicoAmount(1101.6)).toBe("1101.60");
    expect(toIyzicoAmount(0.1 + 0.2)).toBe("0.30");
  });

  it("strips trailing zeros for the RESPONSE signature, which is signed differently", () => {
    // iyzico's own docs call this out: "10.50" is signed as "10.5". Getting it
    // wrong rejects a payment that actually went through.
    expect(signatureAmount("10.50")).toBe("10.5");
    expect(signatureAmount("10.00")).toBe("10");
    expect(signatureAmount("1101.60")).toBe("1101.6");
    expect(signatureAmount("100")).toBe("100");
    expect(signatureAmount(undefined)).toBe("");
  });
});

describe("guards before we ask a guest for money", () => {
  const spec = {
    reference: "RP-1",
    amount: 100,
    currency: "TRY",
    callbackUrl: "https://example.com/return",
    buyer: { firstName: "A", lastName: "B", email: "a@b.c" },
    items: [{ id: "r1", name: "Room", price: 100 }],
    identityNumber: "11111111111",
  };

  it("refuses a currency iyzico doesn't take, instead of a failed redirect", async () => {
    await expect(initializeCheckoutForm(config, { ...spec, currency: "THB" })).rejects.toBeInstanceOf(IyzicoError);
  });

  it("refuses a basket that doesn't sum to the booking total", async () => {
    // iyzico rejects this itself, but only after the guest has been sent away —
    // and the message a hotel would then see is iyzico's, not ours.
    await expect(
      initializeCheckoutForm(config, { ...spec, items: [{ id: "r1", name: "Room", price: 90 }] }),
    ).rejects.toThrow(/basket items total/);
  });

  it("knows which currencies it can take", () => {
    expect(IYZICO_CURRENCIES.has("TRY")).toBe(true);
    expect(IYZICO_CURRENCIES.has("THB")).toBe(false);
  });

  it("needs both halves of the credentials", () => {
    expect(iyzicoConfigured({ apiKey: "k", secretKey: "s" })).toBe(true);
    expect(iyzicoConfigured({ apiKey: "k", secretKey: "" })).toBe(false);
    expect(iyzicoConfigured(null)).toBe(false);
  });

  it("speaks Turkish to Turkish guests and English to everyone else", () => {
    expect(iyzicoLocale("tr")).toBe("tr");
    expect(iyzicoLocale("de")).toBe("en");
    expect(iyzicoLocale(undefined)).toBe("en");
  });
});

describe("what counts as paid", () => {
  const result = {
    paymentId: "1",
    paymentStatus: "SUCCESS",
    paidPrice: 100,
    currency: "TRY",
    conversationId: "RP-1",
    basketId: "RP-1",
    signatureVerified: true,
  };

  it("is paid only when iyzico says SUCCESS", () => {
    expect(iyzicoPaid({ ...result, fraudStatus: 1 })).toBe(true);
    expect(iyzicoPaid({ ...result, paymentStatus: "FAILURE", fraudStatus: 1 })).toBe(false);
  });

  it("is NOT paid while a fraud review is open — that money can still be pulled back", () => {
    expect(iyzicoPaid({ ...result, fraudStatus: 0 })).toBe(false);
    expect(iyzicoPaid({ ...result, fraudStatus: -1 })).toBe(false);
  });
});
