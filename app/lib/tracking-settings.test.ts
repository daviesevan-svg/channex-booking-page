import { describe, expect, it } from "vitest";

import { extractAdsConversion, extractGa4Ids, extractGtmId, isTagged, parseAnalyticsForm } from "./tracking-settings";

// What is pinned here is the hotel's copy-paste. Every one of these inputs is
// something a hotelier will actually put in the box, and each value ends up in
// a <script> on a live booking page — so the shape has to be proven, not
// assumed, and an unparseable field has to fail loudly rather than save empty.

const form = (fields: Record<string, string>) => ({
  get: (name: string) => fields[name] ?? null,
});

describe("pulling IDs out of what Google gives a hotel", () => {
  it("takes a GA4 ID out of the snippet, not just a bare ID", () => {
    const pasted = `<!-- Google tag (gtag.js) -->
      <script async src="https://www.googletagmanager.com/gtag/js?id=G-AB12CD34EF"></script>
      <script>window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);} gtag('js', new Date());
      gtag('config', 'G-AB12CD34EF');</script>`;
    expect(extractGa4Ids(pasted)).toEqual(["G-AB12CD34EF"]);
  });

  it("keeps every ID when a hotel and its agency both tag, without duplicates", () => {
    expect(extractGa4Ids("G-HOTEL123\nG-AGENCY45\nG-HOTEL123")).toEqual(["G-HOTEL123", "G-AGENCY45"]);
  });

  it("finds the GTM container in a snippet", () => {
    expect(extractGtmId("(window,document,'script','dataLayer','GTM-ABC1234');")).toBe("GTM-ABC1234");
  });

  it("splits a pasted Ads conversion snippet into ID and label", () => {
    const pasted = `gtag('event', 'conversion', {'send_to': 'AW-123456789/AbC-D_efGhIjKlMn', 'value': 1.0});`;
    expect(extractAdsConversion(pasted)).toEqual({ id: "AW-123456789", label: "AbC-D_efGhIjKlMn" });
  });

  it("accepts a bare conversion ID with no label in the text", () => {
    expect(extractAdsConversion("AW-123456789")).toEqual({ id: "AW-123456789" });
  });

  it("lower-cased IDs still parse — nobody retypes these accurately", () => {
    expect(extractGa4Ids("g-ab12cd34ef")).toEqual(["G-AB12CD34EF"]);
    expect(extractGtmId("gtm-abc1234")).toBe("GTM-ABC1234");
  });
});

describe("saving the tracking form", () => {
  it("stores only the extracted IDs, never the pasted blob", () => {
    const { value, errors } = parseAnalyticsForm(
      form({
        ga4: `<script src="https://www.googletagmanager.com/gtag/js?id=G-AB12CD34EF"></script>`,
        consent: "banner",
      }),
    );
    expect(errors).toEqual({});
    expect(value.ga4MeasurementIds).toEqual(["G-AB12CD34EF"]);
    expect(JSON.stringify(value)).not.toContain("script");
  });

  it("takes both halves of an Ads conversion from the ID field alone", () => {
    const { value, errors } = parseAnalyticsForm(
      form({ adsId: "gtag('event','conversion',{'send_to':'AW-987654321/XyZ_12-abc'});", consent: "banner" }),
    );
    expect(errors).toEqual({});
    expect(value.adsConversionId).toBe("AW-987654321");
    expect(value.adsConversionLabel).toBe("XyZ_12-abc");
  });

  it("pairs a bare ID with a separately typed label", () => {
    const { value } = parseAnalyticsForm(form({ adsId: "AW-987654321", adsLabel: "XyZ_12-abc", consent: "banner" }));
    expect(value.adsConversionId).toBe("AW-987654321");
    expect(value.adsConversionLabel).toBe("XyZ_12-abc");
  });

  it("refuses an Ads ID with no label — send_to needs the pair, and half of one measures nothing", () => {
    const { value, errors } = parseAnalyticsForm(form({ adsId: "AW-987654321", consent: "banner" }));
    expect(errors.adsLabel).toBe("trkErrAdsLabel");
    expect(value.adsConversionLabel).toBeUndefined();
  });

  it("errors on a field it can't parse instead of saving nothing", () => {
    const { errors } = parseAnalyticsForm(form({ ga4: "my analytics account", gtm: "container 4", consent: "banner" }));
    expect(errors.ga4).toBe("trkErrGa4");
    expect(errors.gtm).toBe("trkErrGtm");
  });

  it("treats an emptied field as a deliberate clear", () => {
    const { value, errors } = parseAnalyticsForm(form({ ga4: "  ", consent: "off" }));
    expect(errors).toEqual({});
    expect(value.ga4MeasurementIds).toBeUndefined();
    expect(value.consent).toBe("off");
  });

  it("falls back to the banner for an unknown or missing posture — the safe one wins by default", () => {
    expect(parseAnalyticsForm(form({})).value.consent).toBe("banner");
    expect(parseAnalyticsForm(form({ consent: "whatever" })).value.consent).toBe("banner");
  });
});

describe("isTagged", () => {
  it("is false for an untagged property, so no banner is shown for nothing", () => {
    expect(isTagged(undefined)).toBe(false);
    expect(isTagged({ consent: "banner" })).toBe(false);
    expect(isTagged({ ga4MeasurementIds: [] })).toBe(false);
  });

  it("is false for half an Ads conversion, which could never fire", () => {
    expect(isTagged({ adsConversionId: "AW-1" })).toBe(false);
  });

  it("is true once anything would actually load", () => {
    expect(isTagged({ ga4MeasurementIds: ["G-AB12CD34EF"] })).toBe(true);
    expect(isTagged({ gtmContainerId: "GTM-ABC1234" })).toBe(true);
    expect(isTagged({ adsConversionId: "AW-123456789", adsConversionLabel: "abc_123" })).toBe(true);
  });
});
