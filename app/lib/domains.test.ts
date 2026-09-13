import { describe, expect, it } from "vitest";

import { customDomainRedirect } from "./domains";

const OWN = "https://book.camptelpoconos.com";
const PID = "cadc7be3-0114-4c88-b8c2-cfe3e08bea41";

describe("customDomainRedirect", () => {
  it("moves a Google Hotels click to the same page on the hotel's domain, params intact", () => {
    const q = "checkin=2026-10-02&checkout=2026-10-04&adults=2&currency=USD&utm_source=google&gclid=abc";
    expect(customDomainRedirect(`https://book.roompanda.com/${PID}/rooms?${q}`, PID, OWN)).toBe(
      `${OWN}/rooms?${q}`,
    );
  });

  it("sends the property home to the domain root, and keeps deeper paths", () => {
    expect(customDomainRedirect(`https://book.roompanda.com/${PID}`, PID, OWN)).toBe(`${OWN}/`);
    expect(customDomainRedirect(`https://book.roompanda.com/${PID}/`, PID, OWN)).toBe(`${OWN}/`);
    expect(customDomainRedirect("https://book.roompanda.com/camptel/p/about", "camptel", OWN)).toBe(
      `${OWN}/p/about`,
    );
    expect(customDomainRedirect(`https://book.roompanda.com/${PID}/manage/BK1?token=t`, PID, OWN)).toBe(
      `${OWN}/manage/BK1?token=t`,
    );
  });

  it("drops React Router's internal _routes param", () => {
    expect(
      customDomainRedirect(`https://book.roompanda.com/${PID}/rooms?checkin=2026-10-02&_routes=x`, PID, OWN),
    ).toBe(`${OWN}/rooms?checkin=2026-10-02`);
  });

  it("stays put for the admin design preview", () => {
    expect(customDomainRedirect(`https://book.roompanda.com/${PID}?style=x&preview=tok`, PID, OWN)).toBeNull();
  });

  it("is a no-op without a live origin or a path segment (custom-domain mount)", () => {
    expect(customDomainRedirect(`https://book.roompanda.com/${PID}/rooms`, PID, null)).toBeNull();
    expect(customDomainRedirect(`${OWN}/rooms`, undefined, OWN)).toBeNull();
    expect(customDomainRedirect(`https://book.roompanda.com/${PID}/rooms`, "//evil.com", OWN)).toBeNull();
  });

  it("never redirects to the origin it is already on, and ignores a mismatched segment", () => {
    expect(customDomainRedirect(`${OWN}/${PID}/rooms`, PID, OWN)).toBeNull();
    expect(customDomainRedirect("https://book.roompanda.com/other/rooms", PID, OWN)).toBeNull();
  });
});
