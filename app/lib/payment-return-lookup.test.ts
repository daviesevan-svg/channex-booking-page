import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionBindError } from "./stripe-session-bind";

const mocks = vi.hoisted(() => ({
  getBookingByReference: vi.fn(), getPending: vi.fn(), deletePending: vi.fn(),
  getVivaOrder: vi.fn(), finalizeBooking: vi.fn(), finalizeFromStripeSession: vi.fn(),
  paymentFromIyzico: vi.fn(), paymentFromVivaTransaction: vi.fn(), paymentFromC2p: vi.fn(),
  rejectMismatchedIyzicoPayment: vi.fn(), rejectMismatchedVivaPayment: vi.fn(), rejectMismatchedC2pPayment: vi.fn(),
  retrieveCheckoutForm: vi.fn(), retrieveVivaTransaction: vi.fn(), inquireC2pPayment: vi.fn(),
}));
vi.mock("./bookings.server", () => ({ getBookingByReference: mocks.getBookingByReference }));
vi.mock("./pending-bookings.server", () => ({ getPending: mocks.getPending, deletePending: mocks.deletePending, getVivaOrder: mocks.getVivaOrder }));
vi.mock("./booking-finalize.server", () => ({ finalizeBooking: mocks.finalizeBooking, finalizeFromStripeSession: mocks.finalizeFromStripeSession, paymentFromIyzico: mocks.paymentFromIyzico, paymentFromVivaTransaction: mocks.paymentFromVivaTransaction, rejectMismatchedIyzicoPayment: mocks.rejectMismatchedIyzicoPayment, rejectMismatchedVivaPayment: mocks.rejectMismatchedVivaPayment, paymentFromC2p: mocks.paymentFromC2p, rejectMismatchedC2pPayment: mocks.rejectMismatchedC2pPayment }));
vi.mock("./property-scope.server", () => ({ resolveRequestProperty: async () => "p1" }));
vi.mock("./overrides.server", () => ({ getIyzicoConfig: async () => ({ key: "iyzico" }), getVivaConfig: async () => ({ key: "viva" }), getC2pConfig: async () => ({ key: "2c2p" }) }));
vi.mock("./2c2p.server", () => ({ inquireC2pPayment: mocks.inquireC2pPayment }));
vi.mock("./iyzico.server", () => ({ retrieveCheckoutForm: mocks.retrieveCheckoutForm }));
vi.mock("./viva.server", () => ({ retrieveVivaTransaction: mocks.retrieveVivaTransaction }));

import { loader as stripe } from "../routes/property/checkout.complete";
import { loader as iyzico } from "../routes/property/iyzico.return";
import { loader as viva } from "../routes/viva.return";
import { loader as c2p } from "../routes/property/2c2p.return";

const pending = { pid: "p1", origin: "https://example.com", returnParams: "checkin=2028-02-01&checkout=2028-02-03&sim=0" };
const payment = { provider: "viva", amount: 100, currency: "GBP" };
const providers = [
  { name: "stripe", run: () => stripe({ params: { channelId: "hotel-slug" }, request: new Request("https://example.com/hotel-slug/checkout/complete?ref=REF1&session_id=cs_1&_routes=abc") } as never) },
  { name: "iyzico", run: () => iyzico({ params: { channelId: "hotel-slug" }, request: new Request("https://example.com/hotel-slug/iyzico/return?ref=REF1&token=tok_1") } as never) },
  { name: "viva", run: () => viva({ request: new Request("https://example.com/viva/return?s=123&t=tx_1") } as never) },
  // 2C2P: nothing but the reference is read from the return — the outcome comes from the inquiry.
  { name: "2c2p", run: () => c2p({ params: { channelId: "hotel-slug" }, request: new Request("https://example.com/hotel-slug/2c2p/return?ref=REF1&respCode=0000") } as never) },
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
  mocks.paymentFromC2p.mockReturnValue(payment);
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
      expect(mocks.inquireC2pPayment).not.toHaveBeenCalled();
    });

    it("preserves provider verification and finalization when the reference is pending", async () => {
      const url = await redirectOf(provider.run);
      expect(url.pathname).toBe("/hotel-slug/confirmation/REF1");
      expect(mocks.getBookingByReference).toHaveBeenCalledWith("p1", "REF1");
      if (provider.name === "stripe") expect(mocks.finalizeFromStripeSession).toHaveBeenCalledWith("REF1", "cs_1");
      else {
        expect(mocks.finalizeBooking).toHaveBeenCalledWith(pending, payment, pending.origin);
        if (provider.name === "iyzico") expect(mocks.retrieveCheckoutForm).toHaveBeenCalledWith({ key: "iyzico" }, "tok_1");
        else if (provider.name === "2c2p") expect(mocks.inquireC2pPayment).toHaveBeenCalledWith({ key: "2c2p" }, "REF1");
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
      mocks.paymentFromC2p.mockReturnValue(undefined);
      const url = await redirectOf(provider.run);
      expect(url.pathname).toBe("/hotel-slug/checkout");
      expect(url.searchParams.has("sim")).toBe(false);
      expect(mocks.finalizeBooking).not.toHaveBeenCalled();
    });
  });
}

// iyzico and 2C2P verify the payment with the credentials of the property in the
// URL. A pending that belongs to a different property must therefore be treated
// as unknown: otherwise a hotel pays ITSELF under another hotel's reference and
// that hotel's booking is confirmed as paid.
describe.each(providers.filter((p) => p.name === "iyzico" || p.name === "2c2p"))(
  "$name return for another property's reference",
  (provider) => {
    it("goes home without verifying, finalizing or touching the pending", async () => {
      mocks.getPending.mockResolvedValue({ ...pending, pid: "someone-else" });
      const url = await redirectOf(provider.run);
      expect(url.pathname).toBe("/hotel-slug");
      expect(url.search).toBe(""); // the other hotel's cart is not carried over
      expect(mocks.retrieveCheckoutForm).not.toHaveBeenCalled();
      expect(mocks.inquireC2pPayment).not.toHaveBeenCalled();
      expect(mocks.finalizeBooking).not.toHaveBeenCalled();
      expect(mocks.deletePending).not.toHaveBeenCalled();
    });
  },
);

// Neither gateway is refunded through the API, so a charge that fails the bind
// is held for the hotel — the guest must not be told it already went back.
it.each(providers.filter((p) => p.name === "iyzico" || p.name === "2c2p"))(
  "$name tells the guest a mismatched charge is held, not refunded",
  async (provider) => {
    mocks.finalizeBooking.mockRejectedValue(new SessionBindError("amount_mismatch", "The charge does not match the stay."));
    const url = await redirectOf(provider.run);
    expect(url.pathname).toBe("/hotel-slug/checkout");
    expect(url.searchParams.get("notice")).toBe("held");
  },
);

it("keeps fail-closed Stripe session binding behavior", async () => {
  mocks.finalizeFromStripeSession.mockRejectedValue(new SessionBindError("unbound_session", "The session belongs to another reference."));
  expect((await redirectOf(providers[0].run)).pathname).toBe("/hotel-slug/checkout");
  expect(mocks.finalizeBooking).not.toHaveBeenCalled();
});
