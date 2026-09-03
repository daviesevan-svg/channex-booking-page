import { describe, expect, it, vi } from "vitest";

// The review request is the one email that sends three times. Only the subject
// line changes between the asks — so the thing worth testing is that the right
// one is picked, that a template written before these fields existed still
// sends, and that no language quietly ships the same line three times.

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: () => {},
}));

const { composeReviewEmail } = await import("./email-render.server");
const { emailDefaults } = await import("./email-defaults.server");
const { LANGUAGES } = await import("./content");
const { sampleBooking } = await import("./email-render.server");

const brand = { accent: "#333333", logoUrl: "", hotelUrl: "" } as never;
const compose = (text: Record<string, string>, attempt?: number) =>
  composeReviewEmail({
    text,
    booking: sampleBooking(),
    hotelName: "Casa Test",
    brand,
    reviewUrl: "https://example.test/p/review/b1",
    attempt,
  }).subject;

const FULL = { subject: "first", subject2: "second", subject3: "third", heading: "h", intro: "i", outro: "" };

describe("review-request subject lines", () => {
  it("uses a different subject for each of the three asks", () => {
    expect(compose(FULL, 1)).toBe("first");
    expect(compose(FULL, 2)).toBe("second");
    expect(compose(FULL, 3)).toBe("third");
  });

  it("previews and test-sends as the first ask", () => {
    // The editor composes without an attempt number.
    expect(compose(FULL)).toBe("first");
  });

  it("falls back to the first subject when a reminder's is blank", () => {
    // A template saved before the reminder fields existed has only `subject`,
    // and an operator may clear one. Either way the send must not go out with
    // an empty subject line.
    expect(compose({ ...FULL, subject2: "", subject3: "   " }, 2)).toBe("first");
    expect(compose({ subject: "only one", heading: "h", intro: "i", outro: "" }, 3)).toBe("only one");
  });

  it("renders {tokens} in the reminder subjects, not just the first", () => {
    const text = { ...FULL, subject2: "A minute, {guest_first_name}?", subject3: "Last chance — {hotel_name}" };
    expect(compose(text, 2)).toBe("A minute, Jamie?");
    expect(compose(text, 3)).toBe("Last chance — Casa Test");
  });

  it("ships three DISTINCT built-in subjects in every guest language", () => {
    // A missed translation is invisible at runtime — the language just falls
    // back to English or repeats itself, which is the bug this replaces.
    for (const { code: lang } of LANGUAGES) {
      const d = emailDefaults("review_request", lang);
      const subjects = [d.subject, d.subject2, d.subject3];
      expect(subjects.every((x) => typeof x === "string" && x.trim().length > 0), `${lang} has a blank subject`).toBe(true);
      expect(new Set(subjects).size, `${lang} repeats a subject line`).toBe(3);
    }
  });

  it("keeps the {tokens} intact in every translated subject", () => {
    // A token typo'd in translation renders literally in a real guest's inbox.
    for (const { code: lang } of LANGUAGES) {
      const d = emailDefaults("review_request", lang);
      for (const s of [d.subject, d.subject2, d.subject3]) {
        for (const token of s.match(/\{[a-z_]+\}/g) ?? []) {
          expect(["{hotel_name}", "{guest_first_name}"], `${lang}: ${s}`).toContain(token);
        }
      }
    }
  });
});
