import { describe, expect, it, vi } from "vitest";

// Google's landing-page redirect: the stay fields are rewritten into the
// funnel's names, and every OTHER param Google sent must come through as-is —
// currency and attribution are what a hotel measures the click by.
const mocks = vi.hoisted(() => ({ origin: null as string | null }));
vi.mock("./properties.server", () => ({ getProperty: async (id: string) => (id === "ours" ? { id } : null) }));
vi.mock("./overrides.server", () => ({ getSettings: async () => ({ websiteDomain: "book.camptelpoconos.com" }) }));
vi.mock("./domains.server", () => ({
  requireCanonicalHost: () => {},
  liveCustomOrigin: async () => mocks.origin,
}));

import { loader } from "../routes/go.booking";

const run = async (qs: string) => {
  const res = await loader({ request: new Request(`https://book.roompanda.com/go/booking?${qs}`), params: {}, context: {} } as never);
  return new URL(res.headers.get("Location")!);
};

describe("/go/booking", () => {
  it("rewrites the stay and forwards every other param untouched", async () => {
    mocks.origin = null;
    const to = await run(
      "channel_id=ours&checkin_date=2026-10-02&checkout_date=2026-10-04&adults=2&currency=USD&language=en&user_country=US&utm_source=google&gclid=abc&promo_code=FALL",
    );
    expect(to.origin + to.pathname).toBe("https://book.roompanda.com/ours/rooms");
    expect(Object.fromEntries(to.searchParams)).toEqual({
      checkin: "2026-10-02",
      checkout: "2026-10-04",
      adults: "2",
      currency: "USD",
      language: "en",
      user_country: "US",
      utm_source: "google",
      gclid: "abc",
      promo_code: "FALL",
    });
    for (const consumed of ["channel_id", "checkin_date", "checkout_date", "length"]) {
      expect(to.searchParams.has(consumed)).toBe(false);
    }
  });

  it("derives checkout from length, and lands on the live custom domain", async () => {
    mocks.origin = "https://book.camptelpoconos.com";
    const to = await run("channel_id=ours&checkin_date=2026-10-02&length=3&adults=1&gclid=abc");
    expect(to.origin + to.pathname).toBe("https://book.camptelpoconos.com/rooms");
    expect(to.searchParams.get("checkout")).toBe("2026-10-05");
    expect(to.searchParams.get("adults")).toBe("1");
    expect(to.searchParams.get("gclid")).toBe("abc");
  });

  it("keeps attribution on the home landing when dates are unusable", async () => {
    mocks.origin = null;
    const to = await run("channel_id=ours&checkin_date=soon&currency=USD&gclid=abc");
    expect(to.origin + to.pathname).toBe("https://book.roompanda.com/ours");
    expect(Object.fromEntries(to.searchParams)).toEqual({ currency: "USD", gclid: "abc" });
    const bare = await run("channel_id=ours");
    expect(bare.toString()).toBe("https://book.roompanda.com/ours");
  });

  it("hands hotels that are not ours to Channex with the exact query string", async () => {
    const to = await run("channel_id=theirs&checkin_date=2026-10-02&length=2&gclid=abc");
    expect(to.origin + to.pathname).toBe("https://app.channex.io/api/v1/meta/googlehotelari/booking_link");
    expect(to.search).toBe("?channel_id=theirs&checkin_date=2026-10-02&length=2&gclid=abc");
  });
});
