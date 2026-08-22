import { describe, expect, it } from "vitest";

import { isAllowedImportImageUrl } from "./image-import-url";

describe("isAllowedImportImageUrl", () => {
  it("allows Booking.com CDN hosts used by the onboard import", () => {
    expect(isAllowedImportImageUrl("https://cf.bstatic.com/xdata/images/hotel/max1024/1.jpg")).toBe(true);
    expect(isAllowedImportImageUrl("https://q-xx.bstatic.com/xdata/images/hotel/max1024/1.jpg")).toBe(true);
    expect(isAllowedImportImageUrl("https://r.bstatic.com/x.jpg")).toBe(true);
    expect(isAllowedImportImageUrl("https://bstatic.com/x.jpg")).toBe(true);
    expect(isAllowedImportImageUrl("https://cf.bstatic.com:443/x.jpg")).toBe(true);
  });

  it("refuses anything a future caller could use as SSRF", () => {
    expect(isAllowedImportImageUrl("http://cf.bstatic.com/x.jpg")).toBe(false);
    expect(isAllowedImportImageUrl("https://evil.com/x.jpg")).toBe(false);
    expect(isAllowedImportImageUrl("https://evil-bstatic.com/x.jpg")).toBe(false);
    expect(isAllowedImportImageUrl("https://bstatic.com.evil.com/x.jpg")).toBe(false);
    expect(isAllowedImportImageUrl("https://127.0.0.1/x.jpg")).toBe(false);
    expect(isAllowedImportImageUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedImportImageUrl("https://localhost/x.jpg")).toBe(false);
    expect(isAllowedImportImageUrl("https://user:pass@cf.bstatic.com/x.jpg")).toBe(false);
    expect(isAllowedImportImageUrl("https://cf.bstatic.com:8443/x.jpg")).toBe(false);
    expect(isAllowedImportImageUrl("not-a-url")).toBe(false);
  });
});
