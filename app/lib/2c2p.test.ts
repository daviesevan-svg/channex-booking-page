import { describe, expect, it } from "vitest";

import {
  C2P_SUCCESS,
  C2pError,
  c2pConfigured,
  c2pLocale,
  c2pPaid,
  signC2pPayload,
  toC2pAmount,
  verifyC2pPayload,
} from "./2c2p.server";

// The JWT vector below was computed independently with node:crypto from 2C2P's
// documented construction (HS256 over base64url(header).base64url(claims), the
// secret used as a UTF-8 string). A test that re-ran this module's own signer
// to produce its expectation would only prove determinism; this one pins the
// bytes, so a "helpful" change (hex-decoding the key, re-ordering claims,
// padding the base64) fails here rather than as 2C2P's flat 9042.

const SECRET = "ECC4E54DBA738857B84A7EBC6B5DC7187B8DA68750E88AB53AAA41F548D6F2D9";
const CLAIMS = { merchantID: "JT01", invoiceNo: "1523953661", description: "item 1", amount: 1000, currencyCode: "SGD" };
const EXPECTED =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJtZXJjaGFudElEIjoiSlQwMSIsImludm9pY2VObyI6IjE1MjM5NTM2NjEiLCJkZXNjcmlwdGlvbiI6Iml0ZW0gMSIsImFtb3VudCI6MTAwMCwiY3VycmVuY3lDb2RlIjoiU0dEIn0." +
  "52-dlt2GBfOTTuauAvpI29O2UnapmsrPjb7qlQcOiTk";

describe("the request JWT", () => {
  it("matches an independently computed HS256 token", async () => {
    expect(await signC2pPayload(SECRET, CLAIMS)).toBe(EXPECTED);
  });

  it("uses the secret as a string, not as hex", async () => {
    // Hex-decoding the key would be the natural mistake given how it looks.
    const asHex = await signC2pPayload(Buffer.from(SECRET, "hex").toString("latin1"), CLAIMS);
    expect(asHex).not.toBe(EXPECTED);
  });
});

describe("the response JWT", () => {
  it("round-trips and returns the claims", async () => {
    const jwt = await signC2pPayload(SECRET, { respCode: "0000", webPaymentUrl: "https://x" });
    expect(await verifyC2pPayload(SECRET, jwt)).toEqual({ respCode: "0000", webPaymentUrl: "https://x" });
  });

  it("rejects a token signed with a different key", async () => {
    const jwt = await signC2pPayload("someone-else", { respCode: "0000" });
    await expect(verifyC2pPayload(SECRET, jwt)).rejects.toBeInstanceOf(C2pError);
  });

  it("rejects a tampered body even with a valid-looking shape", async () => {
    const [h, , s] = EXPECTED.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ respCode: "0000", amount: 1 })).toString("base64url")}.${s}`;
    await expect(verifyC2pPayload(SECRET, forged)).rejects.toThrow(/signature/);
  });

  it("refuses any algorithm but HS256", async () => {
    const head = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ respCode: "0000" })).toString("base64url");
    await expect(verifyC2pPayload(SECRET, `${head}.${body}.`)).rejects.toThrow(/HS256/);
  });
});

describe("amounts", () => {
  it("sends decimals at the currency's display precision", () => {
    expect(toC2pAmount(1000, "SGD")).toBe(1000);
    expect(toC2pAmount(1101.6, "THB")).toBe(1101.6);
    expect(toC2pAmount(0.1 + 0.2, "MYR")).toBe(0.3);
  });

  it("rounds zero-decimal currencies to whole units — 2C2P's IDR rule", () => {
    expect(toC2pAmount(150000.4, "IDR")).toBe(150000);
    expect(toC2pAmount(2500000.5, "VND")).toBe(2500001);
  });
});

describe("paid", () => {
  const base = { respDesc: "", merchantId: "JT01", invoiceNo: "R1", amount: 10, currency: "SGD" };
  it("is only 0000", () => {
    expect(c2pPaid({ ...base, respCode: C2P_SUCCESS })).toBe(true);
    for (const code of ["0001", "2001", "0003", "2002", "4051", "9035", ""]) {
      expect(c2pPaid({ ...base, respCode: code })).toBe(false);
    }
  });
});

describe("config", () => {
  it("needs both a merchant id and a secret", () => {
    expect(c2pConfigured({ merchantId: "JT01", secretKey: "k" })).toBe(true);
    expect(c2pConfigured({ merchantId: "", secretKey: "k" })).toBe(false);
    expect(c2pConfigured({ merchantId: "JT01", secretKey: "" })).toBe(false);
    expect(c2pConfigured(null)).toBe(false);
  });
});

describe("locale", () => {
  it("passes what 2C2P renders and falls back to English", () => {
    expect(c2pLocale("th")).toBe("th");
    expect(c2pLocale("zh-TW")).toBe("zh");
    expect(c2pLocale("de")).toBe("en");
    expect(c2pLocale(undefined)).toBe("en");
  });
});
