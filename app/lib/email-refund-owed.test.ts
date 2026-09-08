import { describe, expect, it, vi } from "vitest";

// The renderer reaches KV only for the brand (emailBrand); composeEmail itself
// takes the brand as an argument, so the KV-backed module is stubbed out.
vi.mock("./site.server", () => ({ getSiteStyle: async () => undefined }));

import { composeEmail, sampleBooking } from "./email-render.server";
import { emailDef } from "./content";
import { emailBrandFor } from "./site-style";
import type { BookingRecord, PaymentInfo } from "./bookings.server";

// The host's cancellation email has to say what the policy owes the guest and
// where the hotel issues it, whenever the refund has NOT already been made —
// always for 2C2P (no refund API wired), and for any gateway when automatic
// refunds are off or failed. A refund that was made shows as "Refunded" and
// nothing is owed; the guest's copy never carries the hotel-facing instruction.

const brand = emailBrandFor("#3f7a52", undefined);
const def = emailDef("cancellation_notification")!;
const text = { subject: "Cancelled {reference}", heading: "Cancelled", intro: "", outro: "" };

function cancelled(payment: Partial<PaymentInfo>): BookingRecord {
  const b = sampleBooking("SGD");
  return {
    ...b,
    lifecycle: "cancelled",
    cancelledAt: new Date().toISOString(),
    // Free cancellation, no deadline: the whole charge is owed back.
    cancellation: { refundable: true, cancelByISO: null },
    payment: {
      provider: "2c2p",
      mode: "payment",
      accountId: "JT01",
      sessionId: b.reference,
      amount: 180,
      currency: "SGD",
      ...payment,
    },
  };
}

const render = (booking: BookingRecord, recipient: "host" | "guest" = "host") =>
  composeEmail({
    def: recipient === "host" ? def : emailDef("booking_cancellation")!,
    text,
    booking,
    hotelName: "Test Hotel",
    brand,
    manageUrl: "https://example.com/manage/1",
    lang: "en",
  }).html;

describe("host cancellation email: refund owed", () => {
  it("names the amount and points a 2C2P hotel at the merchant portal", () => {
    const html = render(cancelled({}));
    expect(html).toContain("Refund owed to guest");
    expect(html).toContain("180.00");
    expect(html).toContain("2C2P merchant portal");
    expect(html).not.toContain("Refunded");
  });

  it("tells other gateways to refund from the booking page", () => {
    const html = render(cancelled({ provider: "stripe", paymentIntentId: "pi_1" }));
    expect(html).toContain("Refund owed to guest");
    expect(html).toContain("booking page in your admin");
    expect(html).not.toContain("2C2P");
  });

  it("shows what was refunded instead, once a refund is recorded", () => {
    const html = render(
      cancelled({ provider: "stripe", refund: { id: "re_1", amount: 180, currency: "SGD", at: new Date().toISOString() } }),
    );
    expect(html).toContain("Refunded");
    expect(html).not.toContain("Refund owed");
  });

  it("owes nothing on a non-refundable booking", () => {
    const b = cancelled({});
    const html = render({ ...b, cancellation: { refundable: false, cancelByISO: null } });
    expect(html).not.toContain("Refund owed");
  });

  it("never puts the hotel-facing instruction in the guest's copy", () => {
    const html = render(cancelled({}), "guest");
    expect(html).not.toContain("Refund owed");
    expect(html).not.toContain("merchant portal");
  });
});
