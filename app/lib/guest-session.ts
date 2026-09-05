// The guest portal's authorization rules, with no I/O — the decisions, so they
// can be tested directly. The cookie and the token crypto live in
// guest-auth.server.ts, which re-exports everything here.
//
// The rule the whole module exists to state: a booking reference proves
// knowledge of ONE record, never ownership of the email address on it. Anyone
// who can make a booking can make one under someone else's address.

export interface GuestSession {
  email: string;
  /** The property this session was proved at, and the only one it works on. */
  pid: string;
  /**
   * The single record this session may see — a booking id or a voucher code.
   *
   * Set when the guest proved a reference and it was the only record we hold
   * for that email at that property. Absent when a magic link proved the
   * mailbox itself.
   */
  only?: string;
}

/** Whether this session may see the record identified by `id`. */
export function sessionCanSee(s: GuestSession, id: string): boolean {
  return !s.only || s.only === id;
}

export type GuestLoginDecision =
  | { kind: "session"; only: string }
  | { kind: "magicLink" };

/**
 * What a correct reference earns.
 *
 * One record — the one just proved — means a record-scoped session reveals
 * nothing the caller did not already type in, so there is nothing to protect
 * and no reason to make an ordinary guest wait for an email. That is the
 * whole argument: it is safe because there is nothing else to show, NOT
 * because the caller has been identified.
 *
 * The moment a second record exists on the address, the extra records belong
 * to whoever owns the mailbox, and only the mailbox can unlock them.
 *
 * `recordCount` must count everything the portal would list — bookings AND
 * vouchers. Counting only bookings would hand a stranger the voucher codes of
 * anyone with a voucher and no booking.
 */
export function guestLoginDecision(input: {
  /** Booking id or voucher code the reference proved. */
  provedId: string;
  /** Total bookings + vouchers for this email at this property, proved one included. */
  recordCount: number;
}): GuestLoginDecision {
  return input.recordCount <= 1
    ? { kind: "session", only: input.provedId }
    : { kind: "magicLink" };
}

/**
 * Whether a magic-link token's audience matches the door it is being used on.
 *
 * Admin and guest links are signed with the same secret and the verifiers
 * ignore unknown fields, so without this a guest portal link would satisfy
 * /admin/verify for any address that happens to be on the allowlist.
 *
 * The asymmetry is deliberate: admin tokens predate the field, so an absent
 * audience still opens the admin door. Guest tokens are new, so every valid
 * one says so and absence proves it is somebody else's token.
 */
export function tokenAudienceOk(aud: unknown, expected: "admin" | "guest"): boolean {
  return expected === "guest" ? aud === "guest" : aud === undefined || aud === "admin";
}
