// @vitest-environment jsdom
//
// The confirmation page is ALWAYS a fresh document: checkout ends in
// redirectDocument, and a paid booking comes back from the provider through
// checkout.complete. So on the one page that reports a sale, gtag does not
// exist yet when the page mounts. These tests mount the real tree the way that
// load does and read back what reached the dataLayer, in order.
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TrackingRoot } from "./tracking-scripts";
import { TrackEvent } from "./tracking-events";
import type { TrackingEvent } from "~/lib/tracking";
import type { AnalyticsSettings } from "~/lib/content";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const analytics = {
  consent: "banner",
  adsConversionId: "AW-123",
  adsConversionLabel: "abcLabel",
} as AnalyticsSettings;

const purchase: TrackingEvent = {
  event: "purchase",
  params: { ecommerce: { transaction_id: "RP-1", value: 240, currency: "EUR" } },
  adsConversion: { sendTo: "AW-123/abcLabel", value: 240, currency: "EUR", transactionId: "RP-1" },
};

const tr = { t: (k: string) => k } as never;

/** gtag commands only (the `arguments` objects), as plain arrays. */
function gtagCommands(): unknown[][] {
  return (window.dataLayer ?? [])
    .filter((e) => Object.prototype.toString.call(e) === "[object Arguments]")
    .map((e) => Array.from(e as ArrayLike<unknown>));
}

let root: Root;
let el: HTMLDivElement;

function mount(granted: { analytics: boolean; ads: boolean }, ask = false) {
  act(() => {
    root.render(
      h(TrackingRoot, { analytics, ask, granted, tr }, h(TrackEvent, { event: purchase, dedupeKey: "rp_purchase_RP-1" })),
    );
  });
}

beforeEach(() => {
  delete window.dataLayer;
  delete window.gtag;
  document.head.innerHTML = "";
  sessionStorage.clear();
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
});

afterEach(() => {
  act(() => root.unmount());
  el.remove();
});

describe("Google Ads conversion on a fresh confirmation page", () => {
  it("is queued, after the consent default and the Ads config", () => {
    mount({ analytics: true, ads: true });
    const cmds = gtagCommands();
    const conv = cmds.findIndex((c) => c[0] === "event" && c[1] === "conversion");
    const def = cmds.findIndex((c) => c[0] === "consent" && c[1] === "default");
    const cfg = cmds.findIndex((c) => c[0] === "config" && c[1] === "AW-123");
    expect(conv).toBeGreaterThan(-1);
    expect(def).toBeGreaterThan(-1);
    expect(cfg).toBeGreaterThan(def);
    expect(conv).toBeGreaterThan(cfg);
    expect(cmds[conv][2]).toEqual({ send_to: "AW-123/abcLabel", value: 240, currency: "EUR", transaction_id: "RP-1" });
  });

  it("also queues the GA4 purchase in gtag form", () => {
    mount({ analytics: true, ads: true });
    expect(gtagCommands().some((c) => c[0] === "event" && c[1] === "purchase")).toBe(true);
  });

  it("is not sent while advertising is declined", () => {
    mount({ analytics: true, ads: false });
    expect(gtagCommands().some((c) => c[1] === "conversion")).toBe(false);
  });

  it("is sent once a guest who had not consented accepts on this page", () => {
    // No stored choice: the banner is up on the confirmation page itself.
    mount({ analytics: false, ads: false }, true);
    expect(gtagCommands().some((c) => c[1] === "conversion")).toBe(false);
    const accept = [...el.querySelectorAll("button")].find((b) => /accept/i.test(b.textContent ?? ""));
    expect(accept).toBeTruthy();
    act(() => accept!.click());
    const cmds = gtagCommands();
    const conv = cmds.findIndex((c) => c[1] === "conversion");
    const cfg = cmds.findIndex((c) => c[0] === "config" && c[1] === "AW-123");
    expect(conv).toBeGreaterThan(cfg);
    expect(cfg).toBeGreaterThan(-1);
  });

  it("fires once per booking across a reload", () => {
    mount({ analytics: true, ads: true });
    act(() => root.unmount());
    delete window.dataLayer;
    delete window.gtag;
    root = createRoot(el);
    mount({ analytics: true, ads: true });
    expect(gtagCommands().some((c) => c[1] === "conversion")).toBe(false);
  });
});
