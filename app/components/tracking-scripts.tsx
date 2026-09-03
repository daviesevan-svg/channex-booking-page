// Loads the hotel's measurement tags, and nothing before it is allowed to.
//
// The load model, which is the whole decision in this file:
//
//   posture "banner"    NOTHING from Google is requested until the guest
//                       accepts. Google calls this "basic" consent mode. The
//                       alternative ("advanced" — load the tag immediately,
//                       denied, so it sends cookieless pings) exists to feed
//                       Google's conversion MODELLING, and modelling needs
//                       roughly 700 ad clicks a day per country before it turns
//                       on. No single hotel is within an order of magnitude of
//                       that, so advanced mode would buy a property nothing at
//                       all while sending every guest's IP to Google before
//                       they were asked. See docs/tracking.md §7.
//
//   posture "external"  the tag DOES load immediately, denied, because the
//                       hotel's own CMP can only grant consent to a tag that
//                       exists. That is the standard CMP integration and it is
//                       their choice of tool, not ours.
//
//   posture "off"       loads immediately, granted.
//
// Events are pushed to `window.dataLayer` regardless — that array is memory,
// not storage, and both GTM and gtag replay what they find in it when they
// load. So a guest who accepts on the checkout page still reports the steps
// they took before accepting, and a guest who declines has had nothing sent.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { ConsentBanner, type ConsentDecision } from "~/components/consent-banner";
import { ATTRIBUTION_COOKIE, ATTRIBUTION_MAX_AGE_SEC, serializeAttribution } from "~/lib/attribution";
import { consentModeSignals } from "~/lib/consent";
import { clickAttribution, type ClickAttribution } from "~/lib/tracking";
import type { Translator } from "~/lib/i18n";
import type { AnalyticsSettings } from "~/lib/content";
import { isTagged } from "~/lib/tracking-settings";

/**
 * What the guest has allowed, for anything that needs to branch on it.
 *
 * Defaults to nothing granted: a component rendered outside the provider is a
 * component on a page with no tags, and "assume denied" is the only safe answer
 * to a question nobody set up.
 */
const ConsentContext = createContext<ConsentDecision>({ analytics: false, ads: false });
export const useConsent = () => useContext(ConsentContext);

/**
 * The click ID from the landing URL, held in memory.
 *
 * Read once, at module load, and never written to the device until advertising
 * consent exists — a gclid is unrecoverable if not taken at landing and not
 * storable before the guest agrees. See lib/attribution.ts.
 */
let landingAttribution: ClickAttribution | null = null;
function captureLanding(): ClickAttribution {
  if (landingAttribution) return landingAttribution;
  landingAttribution = typeof window === "undefined" ? {} : clickAttribution(window.location.search);
  return landingAttribution;
}

function writeAttributionCookie(a: ClickAttribution): void {
  if (!Object.keys(a).length) return;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${ATTRIBUTION_COOKIE}=${encodeURIComponent(serializeAttribution(a))}; Path=/; Max-Age=${ATTRIBUTION_MAX_AGE_SEC}; SameSite=Lax${secure}`;
}

/** Dispatch this to reopen the banner — the footer's "Cookie settings". A
 *  window event rather than context: the link lives several components away in
 *  a layout that already threads twenty props, and consent has exactly one
 *  listener. */
export const CONSENT_OPEN_EVENT = "rp:consent-open";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

function ensureDataLayer(): (...args: unknown[]) => void {
  window.dataLayer = window.dataLayer || [];
  if (!window.gtag) {
    // The canonical shim: gtag pushes its `arguments` object, and gtag.js reads
    // the queue when it loads. Must be a real `function` — an arrow has no
    // `arguments`, and this is the one place that matters.
    window.gtag = function gtag() {
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer!.push(arguments);
    };
  }
  return window.gtag;
}

function injectScript(src: string, id: string): void {
  if (document.getElementById(id)) return;
  const el = document.createElement("script");
  el.async = true;
  el.src = src;
  el.id = id;
  document.head.appendChild(el);
}

/**
 * Configure every destination the guest has now permitted, and no others.
 *
 * Per DESTINATION, not per library, and this is the bit that is easy to get
 * wrong: a `config` for the Ads ID makes gtag send a ping to Google's ad
 * servers the moment it runs. Denied `ad_storage` makes that ping carry no
 * identifier — it does not stop it being sent. So a guest who allowed
 * analytics and refused advertising would still have had a request go to
 * Google's ad domain on their behalf, which is precisely what they declined.
 * The Ads config is therefore withheld entirely until `granted.ads`.
 *
 * Idempotent, and called again on every consent change: a guest who allows
 * analytics now and advertising later gets the Ads destination added at that
 * point rather than on the next page load.
 */
function syncTags(a: AnalyticsSettings, granted: ConsentDecision, done: Set<string>): void {
  const gtag = ensureDataLayer();
  const ga4 = granted.analytics ? (a.ga4MeasurementIds ?? []) : [];
  const adsId = granted.ads ? a.adsConversionId : undefined;
  const wanted = [...ga4, ...(adsId ? [adsId] : [])].filter((id) => !done.has(id));

  if (wanted.length) {
    // gtag.js is loaded once, keyed on whichever destination came first; the
    // rest are `config` calls against the same library.
    injectScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(wanted[0])}`, "rp-gtag");
    if (!done.size) gtag("js", new Date());
    for (const id of wanted) {
      // send_page_view: false because this is a single-page app — the automatic
      // pageview fires once, on the landing document, and then never again for
      // the rest of the funnel. Ours are pushed per route change.
      if (id.startsWith("G-")) gtag("config", id, { send_page_view: false });
      else gtag("config", id);
      done.add(id);
    }
  }

  // The hotel's own container. Loaded once anything is granted: what fires
  // inside it is governed by the Consent Mode state we have already pushed,
  // which is the container's contract with its own tags.
  if (a.gtmContainerId && (granted.analytics || granted.ads) && !done.has(a.gtmContainerId)) {
    done.add(a.gtmContainerId);
    window.dataLayer!.push({ "gtm.start": Date.now(), event: "gtm.js" });
    injectScript(`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(a.gtmContainerId)}`, "rp-gtm");
  }
}

export function TrackingRoot({
  analytics,
  ask,
  granted: initialGranted,
  privacyUrl,
  tr,
  children,
}: {
  analytics: AnalyticsSettings;
  /** Show the banner now (server-decided, so there is no flash). */
  ask: boolean;
  granted: ConsentDecision;
  privacyUrl?: string;
  /** The guest's translator — see ConsentBanner for why it is threaded rather
   *  than taken from useT(). */
  tr: Translator;
  /** The guest tree, so everything under it can read the consent context. */
  children?: React.ReactNode;
}) {
  const [granted, setGranted] = useState(initialGranted);
  const [open, setOpen] = useState(ask);
  const [reopened, setReopened] = useState(false);
  /** Destinations already configured, so a second consent change adds only
   *  what is new. Also the "have we ever loaded" flag: empty means the very
   *  first push must be `default`, not `update`. */
  const done = useRef<Set<string>>(new Set());

  const tagged = isTagged(analytics);

  // Take the click ID out of the URL before the first client-side navigation
  // replaces it. Memory only — writing it down needs consent, below.
  useEffect(() => {
    if (tagged) captureLanding();
  }, [tagged]);

  // Once advertising is allowed, the click ID may be stored: it is what lets
  // this booking be matched to the ad that paid for it, including through the
  // payment redirect, and it is written at the moment permission arrives rather
  // than at landing.
  useEffect(() => {
    if (tagged && granted.ads) writeAttributionCookie(captureLanding());
  }, [tagged, granted.ads]);

  // "Cookie settings" in the footer, and anything else that wants to reopen it.
  useEffect(() => {
    if (!tagged) return;
    const onOpen = () => {
      setReopened(true);
      setOpen(true);
    };
    window.addEventListener(CONSENT_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, onOpen);
  }, [tagged]);

  // Declare the consent state BEFORE anything Google could read it, and load
  // the tags only once something is granted. Both run in the same effect so the
  // ordering can't drift: a `consent default` pushed after gtag.js has already
  // initialised is a default that arrives too late to mean anything.
  useEffect(() => {
    if (!tagged) return;
    const gtag = ensureDataLayer();
    gtag("consent", done.current.size ? "update" : "default", consentModeSignals(granted));
    if (analytics.consent === "external") {
      // The hotel's CMP can only grant consent to a tag that exists, so here —
      // and only here — the tags load denied and wait to be told otherwise.
      syncTags(analytics, { analytics: true, ads: true }, done.current);
      return;
    }
    syncTags(analytics, granted, done.current);
  }, [tagged, granted, analytics]);

  const choose = (choice: ConsentDecision) => {
    setGranted(choice);
    setOpen(false);
    setReopened(false);
  };

  // Reopened from the footer: show them the toggles set to what is in force
  // RIGHT NOW, which is this state and not the loader's — a choice made a
  // moment ago doesn't revalidate the layout, so reading it from loader data
  // reopened the panel on a blank slate and offered to "save" it.
  return (
    <ConsentProvider granted={tagged ? granted : DENIED}>
      {tagged && open ? (
        <ConsentBanner current={reopened ? granted : undefined} onChoice={choose} privacyUrl={privacyUrl} tr={tr} />
      ) : null}
      {children}
    </ConsentProvider>
  );
}

const DENIED: ConsentDecision = { analytics: false, ads: false };

function ConsentProvider({ granted, children }: { granted: ConsentDecision; children?: React.ReactNode }) {
  // Memoised on the two booleans, not the object: a new object every render
  // would re-run every consumer's effects, and one of those consumers fires a
  // purchase conversion.
  const value = useMemo(() => ({ analytics: granted.analytics, ads: granted.ads }), [granted.analytics, granted.ads]);
  return <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>;
}

/** The footer entry that reopens the banner. Required where consent was asked
 *  for: a choice you cannot revisit is not a choice, and "withdraw as easily as
 *  you gave" is the actual wording of the rule. */
export function ConsentSettingsLink({ label }: { label: string }) {
  const open = useCallback(() => window.dispatchEvent(new CustomEvent(CONSENT_OPEN_EVENT)), []);
  return (
    <button type="button" onClick={open} className="hover:text-accent">
      {label}
    </button>
  );
}
