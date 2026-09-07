import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionBindError } from "./stripe-session-bind";

const mocks = vi.hoisted(() => ({
  getBookingByReference: vi.fn(), getPending: vi.fn(), deletePending: vi.fn(),
  getVivaOrder: vi.fn(), finalizeBooking: vi.fn(), finalizeFromStripeSession: vi.fn(),
  paymentFromIyzico: vi.fn(), paymentFromVivaTransaction: vi.fn(),
  rejectMismatchedIyzicoPayment: vi.fn(), rejectMismatchedVivaPayment: vi.fn(),
  retrieveCheckoutForm: vi.fn(), retrieveVivaTransaction: vi.fn(),
}));
vi.mock("./bookings.server", () => ({ getBookingByReference: mocks.getBookingByReference }));
vi.mock("./pending-bookings.server", () => ({ getPending: mocks.getPending, deletePending: mocks.deletePending, getVivaOrder: mocks.getVivaOrder }));
vi.mock("./booking-finalize.server", () => ({ finalizeBooking: mocks.finalizeBooking, finalizeFromStripeSession: mocks.finalizeFromStripeSession, paymentFromIyzico: mocks.paymentFromIyzico, paymentFromVivaTransaction: mocks.paymentFromVivaTransaction, rejectMismatchedIyzicoPayment: mocks.rejectMismatchedIyzicoPayment, rejectMismatchedVivaPayment: mocks.rejectMismatchedVivaPayment }));
vi.mock("./property-scope.server", () => ({ resolveRequestProperty: async () => "p1" }));
vi.mock("./overrides.server", () => ({ getIyzicoConfig: async () => ({ key: "iyzico" }), getVivaConfig: async () => ({ key: "viva" }) }));
vi.mock("./iyzico.server", () => ({ retrieveCheckoutForm: mocks.retrieveCheckoutForm }));
vi.mock("./viva.server", () => ({ retrieveVivaTransaction: mocks.retrieveVivaTransaction }));

import { loader as stripe } from "../routes/property/checkout.complete";
import { loader as iyzico } from "../routes/property/iyzico.return";
import { loader as viva } from "../routes/viva.return";

const pending = { pid: "p1", origin: "https://example.com", returnParams: "checkin=2028-02-01&checkout=2028-02-03&sim=0" };
const payment = { provider: "viva", amount: 100, currency: "GBP" };
const providers = [
  { name: "stripe", run: () => stripe({ params: { channelId: "hotel-slug" }, request: new Request("https://example.com/hotel-slug/checkout/complete?ref=REF1&session_id=cs_1&_routes=abc") } as never) },
  { name: "iyzico", run: () => iyzico({ params: { channelId: "hotel-slug" }, request: new Request("https://example.com/hotel-slug/iyzico/return?ref=REF1&token=tok_1") } as never) },
  { name: "viva", run: () => viva({ request: new Request("https://example.com/viva/return?s=123&t=tx_1") } as never) },
];
async function redirectOf(run: () => Promise<unknown>) {
  try { await run(); } catch (response) {
    expect(response).toBeInstanceOf(Response);
    return new URL((response as Response).headers.get("Location")!, "https://example.com");
  }
  throw Error("Expected redirect");
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getPending.mockResolvedValue(pending);
  mocks.getVivaOrder.mockResolvedValue({ ref: "REF1", pid: "p1", channel: "hotel-slug" });
  mocks.getBookingByReference.mockResolvedValue(undefined);
  mocks.finalizeBooking.mockResolvedValue({ status: "confirmed" });
  mocks.finalizeFromStripeSession.mockResolvedValue({ status: "confirmed" });
  mocks.paymentFromIyzico.mockReturnValue(payment);
  mocks.paymentFromVivaTransaction.mockReturnValue(payment);
});

for (const provider of providers) {
  describe(`${provider.name} payment return point lookup`, () => {
    it.each([
      { status: "confirmed" },
      { status: "failed" },
      { status: "failed", payment: { refund: { id: "refund1" } } },
    ])("reuses an existing %j booking and carries its actual outcome", async (record) => {
      mocks.getBookingByReference.mockResolvedValue(record);
      const url = await redirectOf(provider.run);
      expect(mocks.getBookingByReference).toHaveBeenCalledWith("p1", "REF1");
      expect(mocks.deletePending).toHaveBeenCalledWith("REF1");
      expect(url.pathname).toBe("/hotel-slug/confirmation/REF1");
      expect(url.searchParams.get("status")).toBe(record.status === "failed" ? "failed" : null);
      expect(url.searchParams.get("refunded")).toBe("payment" in record ? "1" : null);
      expect(mocks.finalizeBooking).not.toHaveBeenCalled();
      expect(mocks.finalizeFromStripeSession).not.toHaveBeenCalled();
      expect(mocks.retrieveCheckoutForm).not.toHaveBeenCalled();
      expect(mocks.retrieveVivaTransaction).not.toHaveBeenCalled();
    });

    it("preserves provider verification and finalization when the reference is pending", async () => {
      const url = await redirectOf(provider.run);
      expect(url.pathname).toBe("/hotel-slug/confirmation/REF1");
      expect(mocks.getBookingByReference).toHaveBeenCalledWith("p1", "REF1");
      if (provider.name === "stripe") expect(mocks.finalizeFromStripeSession).toHaveBeenCalledWith("REF1", "cs_1");
      else {
        expect(mocks.finalizeBooking).toHaveBeenCalledWith(pending, payment, pending.origin);
        if (provider.name === "iyzico") expect(mocks.retrieveCheckoutForm).toHaveBeenCalledWith({ key: "iyzico" }, "tok_1");
        else expect(mocks.retrieveVivaTransaction).toHaveBeenCalledWith({ key: "viva" }, "tx_1");
      }
    });

    it("returns unknown/expired references home without finalizing", async () => {
      mocks.getPending.mockResolvedValue(undefined);
      const url = await redirectOf(provider.run);
      expect(url.pathname).toBe("/hotel-slug");
      expect(mocks.finalizeBooking).not.toHaveBeenCalled();
      expect(mocks.finalizeFromStripeSession).not.toHaveBeenCalled();
    });

    it("returns incomplete payments to checkout without reporting success", async () => {
      mocks.finalizeFromStripeSession.mockResolvedValue(undefined);
      mocks.paymentFromIyzico.mockReturnValue(undefined);
      mocks.paymentFromVivaTransaction.mockReturnValue(undefined);
      const url = await redirectOf(provider.run);
      expect(url.pathname).toBe("/hotel-slug/checkout");
      expect(url.searchParams.has("sim")).toBe(false);
      expect(mocks.finalizeBooking).not.toHaveBeenCalled();
    });
  });
}

it("keeps fail-closed Stripe session binding behavior", async () => {
  mocks.finalizeFromStripeSession.mockRejectedValue(new SessionBindError("unbound_session", "The session belongs to another reference."));
  expect((await redirectOf(providers[0].run)).pathname).toBe("/hotel-slug/checkout");
  expect(mocks.finalizeBooking).not.toHaveBeenCalled();
});
