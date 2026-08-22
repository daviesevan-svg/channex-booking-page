import { describe, expect, it } from "vitest";

import {
  ADMIN_LOGIN_CHECK_EMAIL,
  ADMIN_LOGIN_MISSING_EMAIL,
  ADMIN_LOGIN_THROTTLED,
  adminLoginPublicResult,
  shouldSendAdminMagicLink,
} from "./admin-login";

describe("adminLoginPublicResult", () => {
  it("returns the same check-email copy for allowed and unknown emails", () => {
    const allowed = adminLoginPublicResult({ hasEmail: true, allowed: true, throttled: false });
    const unknown = adminLoginPublicResult({ hasEmail: true, allowed: false, throttled: false });
    expect(allowed).toEqual(ADMIN_LOGIN_CHECK_EMAIL);
    expect(unknown).toEqual(allowed);
  });

  it("asks for an email when the field is empty", () => {
    expect(adminLoginPublicResult({ hasEmail: false, allowed: false, throttled: false })).toEqual(
      ADMIN_LOGIN_MISSING_EMAIL,
    );
  });

  it("returns the same throttle copy regardless of allowlist membership", () => {
    const allowed = adminLoginPublicResult({ hasEmail: true, allowed: true, throttled: true });
    const unknown = adminLoginPublicResult({ hasEmail: true, allowed: false, throttled: true });
    expect(allowed).toEqual(ADMIN_LOGIN_THROTTLED);
    expect(unknown).toEqual(allowed);
  });
});

describe("shouldSendAdminMagicLink", () => {
  it("sends only when the email is allowed and the attempt is not throttled", () => {
    expect(shouldSendAdminMagicLink(true, false)).toBe(true);
    expect(shouldSendAdminMagicLink(false, false)).toBe(false);
    expect(shouldSendAdminMagicLink(true, true)).toBe(false);
    expect(shouldSendAdminMagicLink(false, true)).toBe(false);
  });
});
