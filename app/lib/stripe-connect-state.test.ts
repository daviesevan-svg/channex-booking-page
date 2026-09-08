import { describe, expect, it } from "vitest";

import {
  decodeConnectState,
  encodeConnectState,
  generateConnectNonce,
  matchConnectState,
  parseConnectPending,
  parseReturnOrigin,
  type StripeConnectPending,
} from "./stripe-connect-state";

const VICTIM_UUID = "439ec597-8caf-47be-b07d-663a9602c79c";
const OTHER_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function pending(propertyId = VICTIM_UUID, nonce = generateConnectNonce()): StripeConnectPending {
  return { nonce, propertyId };
}

describe("generateConnectNonce", () => {
  it("is not a property UUID and is unique per call", () => {
    const a = generateConnectNonce();
    const b = generateConnectNonce();
    expect(a).not.toBe(b);
    expect(a).not.toBe(VICTIM_UUID);
    expect(a).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});

describe("parseConnectPending", () => {
  it("reads a well-formed session value", () => {
    expect(parseConnectPending({ nonce: "abc", propertyId: VICTIM_UUID })).toEqual({
      nonce: "abc",
      propertyId: VICTIM_UUID,
    });
  });

  it("rejects missing, empty, or malformed values", () => {
    expect(parseConnectPending(null)).toBeNull();
    expect(parseConnectPending(undefined)).toBeNull();
    expect(parseConnectPending(VICTIM_UUID)).toBeNull();
    expect(parseConnectPending({ nonce: "abc" })).toBeNull();
    expect(parseConnectPending({ propertyId: VICTIM_UUID })).toBeNull();
    expect(parseConnectPending({ nonce: "", propertyId: VICTIM_UUID })).toBeNull();
    expect(parseConnectPending({ nonce: "abc", propertyId: "" })).toBeNull();
  });
});

describe("matchConnectState", () => {
  it("binds a matching nonce to the stored propertyId, not a client-supplied UUID", () => {
    const stored = pending();
    expect(matchConnectState(stored, stored.nonce)).toBe(VICTIM_UUID);
    // The old attack: state is the victim property UUID. Must not match.
    expect(matchConnectState(stored, VICTIM_UUID)).toBeNull();
    expect(matchConnectState(stored, OTHER_UUID)).toBeNull();
  });

  it("rejects missing, unknown, or already-consumed state", () => {
    const stored = pending();
    expect(matchConnectState(stored, null)).toBeNull();
    expect(matchConnectState(stored, "")).toBeNull();
    expect(matchConnectState(stored, generateConnectNonce())).toBeNull();
    expect(matchConnectState(null, stored.nonce)).toBeNull();
    // One-time: after the caller deletes pending, a replay of the same state fails.
    expect(matchConnectState(null, stored.nonce)).toBeNull();
  });
});

describe("partner-host round trip (encode/decode state)", () => {
  it("a bare nonce is its own state and decodes with no origin", () => {
    const nonce = generateConnectNonce();
    expect(encodeConnectState(nonce)).toBe(nonce);
    expect(decodeConnectState(nonce)).toEqual({ nonce, returnOrigin: null });
    expect(nonce).not.toContain(".");
  });

  it("carries a partner admin origin and gives back the bare nonce", () => {
    const nonce = generateConnectNonce();
    const state = encodeConnectState(nonce, "https://admin.zimrly.com");
    expect(state.startsWith(`${nonce}.`)).toBe(true);
    expect(decodeConnectState(state)).toEqual({ nonce, returnOrigin: "https://admin.zimrly.com" });
    // The forwarded state must still match the session nonce on the partner host.
    expect(matchConnectState(pending(VICTIM_UUID, nonce), decodeConnectState(state)!.nonce)).toBe(VICTIM_UUID);
  });

  it("refuses to encode anything but a bare http(s) origin", () => {
    const nonce = generateConnectNonce();
    expect(() => encodeConnectState(nonce, "https://admin.zimrly.com/admin")).toThrow();
    expect(() => encodeConnectState(nonce, "javascript:alert(1)")).toThrow();
    expect(() => encodeConnectState(nonce, "https://user:pw@admin.zimrly.com")).toThrow();
    expect(() => encodeConnectState(nonce, "admin.zimrly.com")).toThrow();
  });

  it("rejects a tampered or non-origin suffix instead of guessing", () => {
    const nonce = generateConnectNonce();
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    expect(decodeConnectState(`${nonce}.${b64("https://evil.example/admin/payments/callback")}`)).toBeNull();
    expect(decodeConnectState(`${nonce}.${b64("https://evil.example/?x=1")}`)).toBeNull();
    expect(decodeConnectState(`${nonce}.${b64("ftp://evil.example")}`)).toBeNull();
    expect(decodeConnectState(`${nonce}.${b64("https://a:b@evil.example")}`)).toBeNull();
    expect(decodeConnectState(`${nonce}.not!base64`)).toBeNull();
    expect(decodeConnectState(`${nonce}.`)).toBeNull();
    expect(decodeConnectState(`.${b64("https://evil.example")}`)).toBeNull();
    expect(decodeConnectState(null)).toBeNull();
    expect(decodeConnectState("")).toBeNull();
  });

  it("parseReturnOrigin accepts exactly an origin", () => {
    expect(parseReturnOrigin("https://admin.zimrly.com")).toBe("https://admin.zimrly.com");
    expect(parseReturnOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(parseReturnOrigin("https://admin.zimrly.com/")).toBeNull();
    expect(parseReturnOrigin("https://admin.zimrly.com:443")).toBeNull();
    expect(parseReturnOrigin("HTTPS://ADMIN.ZIMRLY.COM")).toBeNull();
  });
});
