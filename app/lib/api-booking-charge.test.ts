import { describe, expect, it } from "vitest";

import { apiBookingChargePath } from "./api-booking-charge";

describe("apiBookingChargePath", () => {
  it("never opens a gateway when the booking will only be simulated", () => {
    expect(apiBookingChargePath({ live: false, due: 120, gatewayKind: "stripe" })).toBe("uncarded");
    expect(apiBookingChargePath({ live: false, due: 120, gatewayKind: "viva" })).toBe("uncarded");
    expect(apiBookingChargePath({ live: false, due: 0, gatewayKind: "stripe" })).toBe("uncarded");
    expect(apiBookingChargePath({ live: false, due: 50, gatewayKind: undefined })).toBe("uncarded");
  });

  it("refuses a paid live rate with no gateway (must not book unpaid)", () => {
    expect(apiBookingChargePath({ live: true, due: 80, gatewayKind: undefined })).toBe("not_configured");
  });

  it("sends a live paid stay to the connected gateway", () => {
    expect(apiBookingChargePath({ live: true, due: 80, gatewayKind: "stripe" })).toBe("stripe");
    expect(apiBookingChargePath({ live: true, due: 80, gatewayKind: "viva" })).toBe("viva");
  });

  it("uses Stripe setup mode when nothing is due (guarantee card)", () => {
    expect(apiBookingChargePath({ live: true, due: 0, gatewayKind: "stripe" })).toBe("stripe");
  });

  it("books a live Viva stay with nothing due without a card (Viva has no setup mode)", () => {
    expect(apiBookingChargePath({ live: true, due: 0, gatewayKind: "viva" })).toBe("uncarded");
    expect(apiBookingChargePath({ live: true, due: 0, gatewayKind: undefined })).toBe("uncarded");
  });
});
