import { beforeEach, describe, expect, it, vi } from "vitest";

// The "couldn't confirm" email must never tell a guest they were refunded when
// no refund was made. `payment.refund` is only set after a gateway refund
// succeeded; without it (iyzico/2C2P, which we never refund through, or an
// automatic refund that failed) the guest gets the refund-to-follow copy and
// the hotel is told it owes the money back. Real template defaults and real
// rendering; only settings, KV and the SparkPost call are faked.

const sent: { to: string[]; subject: string; html: string; reply_to?: string }[] = [];
let settings: Record<string, unknown> = {};
let overrides: Record<string, unknown> = {};

vi.mock("./config.server", () => ({
  getConfig: () => ({ sparkpostApiKey: "k", sparkpostApiUrl: "https://sparkpost.test", emailFrom: "Bookings <bookings@example.test>" }),
}));
vi.mock("./site.server", () => ({ getSiteStyle: async () => undefined }));
vi.mock("./partners.server", () => ({
  brandOf: () => ({}),
  getPartner: async () => null,
  partnerForProperty: async () => null,
}));
vi.mock("./overrides.server", async () => {
  const { withEmailDefaults } = await import("./email-defaults.server");
  return {
    getSettings: async () => settings,
    getOverrides: async () => overrides,
    getEmailTemplate: async (_pid: string, id: string, lang?: string) => withEmailDefaults(id, {}, lang),
  };
});

vi.stubGlobal(
  "fetch",
  vi.fn(async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    sent.push({ to: b.recipients.map((r: { address: string }) => r.address), subject: b.content.subject, html: b.content.html, reply_to: b.content.reply_to });
    return new Response("{}", { status: 200 });
  }),
);

const { sendBookingFailedEmail } = await import("./email.server");
const { sampleBooking } = await import("./email-render.server");
import type { BookingRecord, PaymentInfo } from "./bookings.server";

function failed(payment: Partial<PaymentInfo>, lang = "en"): BookingRecord {
  const b = sampleBooking("TRY");
  return {
    ...b,
    status: "failed",
    lang,
    payment: { provider: "iyzico", mode: "payment", accountId: "m", sessionId: b.reference, transactionId: "2718", amount: 180, currency: "TRY", ...payment },
  };
}

beforeEach(() => {
  sent.length = 0;
  settings = { hostNotifyEmail: "frontdesk@hotel.test", notifyHostOnBooking: false, notifyHostOnCancel: false };
  overrides = { hotelName: "Hotel Test", email: "owner@hotel.test" };
});

describe("sendBookingFailedEmail", () => {
  it("unrefunded iyzico charge: guest is told a refund is to follow, and the hotel that it owes one", async () => {
    await sendBookingFailedEmail("p1", failed({}), "https://example.test");
    expect(sent).toHaveLength(2);
    const [guest, host] = sent;

    expect(guest.to).toEqual(["jamie@example.com"]);
    expect(guest.html).toContain("owed a full refund");
    expect(guest.html).not.toContain("We've refunded");

    // Sent although both host notification toggles are off: it is money owed.
    expect(host.to).toEqual(["frontdesk@hotel.test"]);
    expect(host.subject).toContain("Refund needed");
    expect(host.subject).toContain("AB7C9XK2");
    expect(host.html).toContain("has NOT been refunded");
    expect(host.html).toContain("mark it refunded");
    expect(host.reply_to).toBe("jamie@example.com");
  });

  it("falls back to the property's contact email for the hotel alert", async () => {
    settings = {};
    await sendBookingFailedEmail("p1", failed({ provider: "2c2p" }), "https://example.test");
    expect(sent.map((m) => m.to[0])).toEqual(["jamie@example.com", "owner@hotel.test"]);
  });

  it("a refund that went through: the original 'refunded' email, and no hotel alert", async () => {
    const refund = { id: "re_1", amount: 180, currency: "TRY", at: new Date().toISOString(), by: "auto (unavailable at booking)" };
    await sendBookingFailedEmail("p1", failed({ provider: "stripe", paymentIntentId: "pi_1", refund }), "https://example.test");
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain("We've refunded");
  });

  it("a Stripe refund that failed is treated like a manual gateway", async () => {
    await sendBookingFailedEmail("p1", failed({ provider: "stripe", paymentIntentId: "pi_1" }), "https://example.test");
    expect(sent).toHaveLength(2);
    expect(sent[0].html).not.toContain("We've refunded");
  });

  it("the guest's copy is in the guest's language, the hotel's in the default one", async () => {
    await sendBookingFailedEmail("p1", failed({}, "tr"), "https://example.test");
    const [guest, host] = sent;
    expect(guest.html).toContain("iade edilecek");
    expect(guest.html).not.toContain("iade ettik");
    expect(host.subject).toContain("Refund needed");
  });
});

describe("editor preview sample", () => {
  it("has no recorded refund for the refund-still-owed templates, and keeps it for the original", async () => {
    const { sampleBookingFor } = await import("./email-render.server");
    expect(sampleBookingFor("booking_failed_refund_pending").payment?.refund).toBeUndefined();
    expect(sampleBookingFor("booking_failed_notification").payment?.refund).toBeUndefined();
    expect(sampleBookingFor("booking_failed").payment?.refund).toBeDefined();
  });
});
