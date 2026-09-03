// Pushing the events. Everything about WHAT to send lives in lib/tracking.ts;
// this is only about when, and about not sending anything twice.
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

import { useConsent } from "~/components/tracking-scripts";
import { cartDelta, type StayParams, type TrackingEvent } from "~/lib/tracking";

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

/**
 * A funnel event, once per distinct signature per page load.
 *
 * Not sessionStorage — unlike `purchase`, seeing the same room list twice in a
 * session is a real second view and should report as one. The signature is
 * what makes a repeat a repeat: same page, same search, same cart. Module
 * scope so a remount (React strict mode, a re-render on consent change)
 * doesn't refire it.
 */
const sentSignatures = new Set<string>();

export function TrackFunnel({ event, signature }: { event: TrackingEvent | null; signature: string }) {
  useEffect(() => {
    if (!event || sentSignatures.has(signature)) return;
    sentSignatures.add(signature);
    push(event.event, event.params);
  }, [event, signature]);
  return null;
}

/**
 * add_to_cart / remove_from_cart, from the change in `sel`.
 *
 * Two pieces of state have to survive a route change, so both are module scope:
 * the last `sel` we saw (there is no delta without a before), and every cart
 * line we have ever been told about. The second is what lets a REMOVAL be
 * named — the room is by definition absent from the loader that notices it is
 * gone, so if we did not remember it we could only report that something
 * unidentified left the cart.
 */
let lastSel: string | null = null;
const knownLines = new Map<string, { roomId: string; roomTitle: string; rateTitle: string; total: number }>();

export function TrackCart({
  sel,
  lines,
  stay,
}: {
  /** The raw `sel` param — diffed as text, so it matches what the URL carries. */
  sel: string;
  /** This page's resolved cart, keyed by the same token text. */
  lines: Record<string, { roomId: string; roomTitle: string; rateTitle: string; total: number }>;
  stay: StayParams;
}) {
  useEffect(() => {
    for (const [token, line] of Object.entries(lines)) knownLines.set(token, line);
    // First sel of the session: remembered, never reported. A shared link
    // carrying three rooms is not three adds the guest made.
    const events = cartDelta(lastSel, sel, (t) => knownLines.get(t), stay);
    lastSel = sel;
    for (const e of events) push(e.event, e.params);
  }, [sel, lines, stay]);
  return null;
}
