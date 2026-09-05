import { describe, expect, it } from "vitest";

import {
  type GuestSession,
  guestLoginDecision,
  sessionCanSee,
  tokenAudienceOk,
} from "./guest-session";

const proved = (only?: string): GuestSession => ({ email: "guest@example.com", pid: "hotel-a", only });

describe("guestLoginDecision", () => {
  it("lets a lone record straight in, pinned to itself", () => {
    expect(guestLoginDecision({ provedId: "bk_1", recordCount: 1 })).toEqual({
      kind: "session",
      only: "bk_1",
    });
  });

  it("demands the mailbox as soon as a second record exists", () => {
    // The attack this exists for: a stranger books under someone else's email
    // to mint a reference. Their own booking is what pushes the count to 2.
    expect(guestLoginDecision({ provedId: "bk_attacker", recordCount: 2 })).toEqual({
      kind: "magicLink",
    });
    expect(guestLoginDecision({ provedId: "bk_attacker", recordCount: 9 })).toEqual({
      kind: "magicLink",
    });
  });

  it("treats a count of zero as the lone case rather than throwing", () => {
    // Can't happen — the proved record is in the count — but a miscount must
    // not become an exception on a login path.
    expect(guestLoginDecision({ provedId: "bk_1", recordCount: 0 }).kind).toBe("session");
  });
});

describe("sessionCanSee", () => {
  it("pins a reference-proved session to the one record it proved", () => {
    const s = proved("bk_1");
    expect(sessionCanSee(s, "bk_1")).toBe(true);
    expect(sessionCanSee(s, "bk_2")).toBe(false);
    expect(sessionCanSee(s, "RP-AB12-CD34")).toBe(false);
  });

  it("lets a mailbox-proved session see everything", () => {
    const s = proved(undefined);
    expect(sessionCanSee(s, "bk_1")).toBe(true);
    expect(sessionCanSee(s, "bk_2")).toBe(true);
  });
});

describe("tokenAudienceOk", () => {
  it("keeps a guest portal link out of the admin door", () => {
    expect(tokenAudienceOk("guest", "admin")).toBe(false);
  });

  it("keeps an admin link out of the guest portal", () => {
    expect(tokenAudienceOk("admin", "guest")).toBe(false);
    // An admin token predating the field has no audience at all.
    expect(tokenAudienceOk(undefined, "guest")).toBe(false);
  });

  it("still accepts admin tokens minted before the field existed", () => {
    expect(tokenAudienceOk(undefined, "admin")).toBe(true);
    expect(tokenAudienceOk("admin", "admin")).toBe(true);
  });

  it("accepts nothing unrecognised at either door", () => {
    for (const aud of ["", "GUEST", "partner", 1, null, {}]) {
      expect(tokenAudienceOk(aud, "guest")).toBe(false);
      expect(tokenAudienceOk(aud, "admin")).toBe(false);
    }
  });
});
