// Pushing the events. Everything about WHAT to send lives in lib/tracking.ts;
// this is only about when, and about not sending anything twice.
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

import { useConsent } from "~/components/tracking-scripts";
import type { TrackingEvent } from "~/lib/tracking";

function push(event: string, params: Record<string, unknown>): void {
  window.dataLayer = window.dataLayer || [];
  // GTM reads `{event: "..."}` objects; gtag reads its own `arguments` form.
  // Both are pushed so a hotel with a container and a hotel with a bare
  // Measurement ID get the same data, and neither is made to translate.
  window.dataLayer.push({ event, ...params });
  window.gtag?.("event", event, params);
}

/**
 * A virtual pageview per route change.
 *
 * Google's automatic pageview fires once, on the landing document, and never
 * again — this is a single-page app, so without this the whole funnel reports
 * as one page and every hotel concludes the booking engine has no traffic. It
 * is also the exact failure WebHotelier papers over by telling customers never
 * to load Analytics through Tag Manager.
 */
export function PageViews() {
  const location = useLocation();
  const last = useRef<string | null>(null);
  useEffect(() => {
    const path = location.pathname + location.search;
    // The landing view is pushed too: `send_page_view: false` means gtag isn't
    // sending its own, so skipping the first would lose the entry page.
    if (last.current === path) return;
    last.current = path;
    push("page_view", { page_path: location.pathname, page_location: window.location.href, page_title: document.title });
  }, [location.pathname, location.search]);
  return null;
}

/**
 * One event, once.
 *
 * `key` is what makes it once: the confirmation page is refreshable,
 * bookmarkable and reachable by back-navigation, and every one of those would
 * otherwise report another sale. sessionStorage rather than a ref because a
 * refresh remounts the component with fresh refs; per-tab is the right scope,
 * since a genuinely second booking has a different reference.
 */
export function TrackEvent({ event, dedupeKey }: { event: TrackingEvent | null; dedupeKey: string }) {
  const consent = useConsent();
  const adsGranted = consent.ads;
  useEffect(() => {
    if (!event) return;
    let already = false;
    try {
      already = sessionStorage.getItem(dedupeKey) === "1";
      sessionStorage.setItem(dedupeKey, "1");
    } catch {
      // Private mode, or storage blocked. Sending a duplicate is a smaller
      // error than sending nothing, so carry on.
    }
    if (already) return;

    push(event.event, event.params);

    // The Google Ads conversion is a separate send_to, and it is gated on LIVE
    // consent rather than on what the server believed when it rendered: a guest
    // can have refused advertising a second ago. Pushing it regardless would
    // leave it queued in the dataLayer, and gtag would fire it the moment it
    // loaded for analytics — an ads ping for a guest who declined ads.
    if (event.adsConversion && adsGranted) {
      window.gtag?.("event", "conversion", {
        send_to: event.adsConversion.sendTo,
        value: event.adsConversion.value,
        currency: event.adsConversion.currency,
        transaction_id: event.adsConversion.transactionId,
      });
    }
  }, [event, dedupeKey, adsGranted]);
  return null;
}
