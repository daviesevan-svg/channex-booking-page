/** Public copy for `/admin/login`. Allowlist membership is never reflected in
 *  the response — unknown and allowed emails both get the check-email success
 *  so the form cannot be used to enumerate operators. */

export type AdminLoginPublicResult = { ok: true } | { error: string };

export const ADMIN_LOGIN_CHECK_EMAIL = { ok: true } as const;
export const ADMIN_LOGIN_MISSING_EMAIL = { error: "Enter your email address." } as const;
export const ADMIN_LOGIN_THROTTLED = {
  error: "Too many sign-in attempts. Try again in a few minutes.",
} as const;

/** 3 attempts / 15 minutes, per IP and per email. Same blunt KV limiter as
 *  web checkout — fail-open and racy is acceptable here. */
export const ADMIN_LOGIN_LIMIT = 3;
export const ADMIN_LOGIN_WINDOW_SEC = 15 * 60;

export function adminLoginPublicResult(input: {
  hasEmail: boolean;
  allowed: boolean;
  throttled: boolean;
}): AdminLoginPublicResult {
  if (!input.hasEmail) return ADMIN_LOGIN_MISSING_EMAIL;
  if (input.throttled) return ADMIN_LOGIN_THROTTLED;
  // `allowed` is intentionally unused: the public copy must not reveal
  // whether this email can sign in here.
  void input.allowed;
  return ADMIN_LOGIN_CHECK_EMAIL;
}

export function shouldSendAdminMagicLink(allowed: boolean, throttled: boolean): boolean {
  return allowed && !throttled;
}
