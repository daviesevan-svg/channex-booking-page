import { describe, expect, it } from "vitest";

import {
  generateConnectNonce,
  matchConnectState,
  parseConnectPending,
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
