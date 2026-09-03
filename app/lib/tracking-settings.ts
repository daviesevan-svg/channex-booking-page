// Parsing and validation for the measurement tags on /admin/tracking.
//
// Pure — no KV, no DOM — because this is the boundary where a hotel's
// copy-paste meets our page. Every value here ends up in a <script> on a live
// booking page, so nothing reaches storage that hasn't matched a known shape.
// The pasted blob itself is never stored: we take the ID out of it and discard
// the rest, which is both the affordance (paste the snippet Google gave you)
// and the validation boundary (parse a known shape, reject everything else).
//
// Errors are admin-i18n keys, not sentences: the person pasting this may be
// reading the panel in German.
import type { AnalyticsSettings, ConsentPosture } from "./content";

// Google's own formats. Deliberately anchored on the prefix and a minimum
// length rather than an exact one — Google has lengthened these before, and a
// regex that is too tight rejects a valid ID with no way for the hotel to
// override us.
const GA4_ID = /\bG-[A-Z0-9]{4,}\b/g;
const GTM_ID = /\bGTM-[A-Z0-9]{4,}\b/;
const ADS_ID = /\bAW-\d{6,}\b/;
/** `send_to: 'AW-123456789/AbC-D_efGhIjKlMn'` — the ID and label as one string,
 *  which is how the Google Ads conversion snippet carries them. */
const ADS_SEND_TO = /\b(AW-\d{6,})\/([A-Za-z0-9_-]{6,})\b/;
/** A label on its own, from the second field. */
const ADS_LABEL = /^[A-Za-z0-9_-]{6,}$/;

/** Every GA4 ID in a blob, in order, without duplicates. Accepts a bare ID, a
 *  list one per line, or a pasted gtag snippet. */
export function extractGa4Ids(text: string): string[] {
  return [...new Set(text.toUpperCase().match(GA4_ID) ?? [])];
}

export function extractGtmId(text: string): string | undefined {
  return text.toUpperCase().match(GTM_ID)?.[0];
}

/**
 * The Google Ads conversion pair.
 *
 * A hotel can paste the whole conversion snippet into the ID field and get both
 * halves out of it, because that is what they are actually holding — Google
 * hands them a `send_to` and nothing that separates the two. Falls back to a
 * bare `AW-…` when there is no label in the text.
 */
export function extractAdsConversion(text: string): { id?: string; label?: string } {
  const pair = text.match(ADS_SEND_TO);
  if (pair) return { id: pair[1].toUpperCase(), label: pair[2] };
  const id = text.toUpperCase().match(ADS_ID)?.[0];
  return id ? { id } : {};
}

function isPosture(v: string): v is ConsentPosture {
  return v === "banner" || v === "external" || v === "off";
}

export interface AnalyticsParse {
  value: AnalyticsSettings;
  /** Field name → admin-i18n error key. Empty when everything parsed. */
  errors: Record<string, string>;
}

/**
 * Read the form into settings, rejecting anything unrecognised.
 *
 * A field the hotel filled in but we couldn't parse is an ERROR, never a silent
 * drop: "I pasted my conversion tag and bookings still aren't showing in Google
 * Ads" is the single most expensive support conversation this feature can
 * produce, and it is entirely avoidable at the point of typing.
 */
export function parseAnalyticsForm(form: {
  get(name: string): FormDataEntryValue | null;
}): AnalyticsParse {
  const str = (name: string) => String(form.get(name) ?? "").trim();
  const errors: Record<string, string> = {};
  const value: AnalyticsSettings = {};

  const ga4Raw = str("ga4");
  if (ga4Raw) {
    const ids = extractGa4Ids(ga4Raw);
    if (!ids.length) errors.ga4 = "trkErrGa4";
    else value.ga4MeasurementIds = ids;
  }

  const gtmRaw = str("gtm");
  if (gtmRaw) {
    const id = extractGtmId(gtmRaw);
    if (!id) errors.gtm = "trkErrGtm";
    else value.gtmContainerId = id;
  }

  // The two Ads fields are parsed together: the ID field may carry both halves
  // (a pasted snippet), and a label typed on its own is only meaningful beside
  // an ID.
  const adsRaw = str("adsId");
  const labelRaw = str("adsLabel");
  if (adsRaw) {
    const { id, label } = extractAdsConversion(adsRaw);
    if (!id) {
      errors.adsId = "trkErrAdsId";
    } else {
      value.adsConversionId = id;
      const chosen = label ?? (ADS_LABEL.test(labelRaw) ? labelRaw : undefined);
      // An ID with no label can't be sent: `send_to` needs the pair. Better to
      // refuse the save than to store a tag that will never fire.
      if (!chosen) errors.adsLabel = "trkErrAdsLabel";
      else value.adsConversionLabel = chosen;
    }
  } else if (labelRaw) {
    errors.adsId = "trkErrAdsIdMissing";
  }

  const posture = str("consent");
  value.consent = isPosture(posture) ? posture : "banner";

  return { value, errors };
}

/** Whether anything third-party would load for this property. Drives both the
 *  banner (nothing to consent to = no banner) and the scripts. */
export function isTagged(a: AnalyticsSettings | undefined): boolean {
  return Boolean(
    a && ((a.ga4MeasurementIds?.length ?? 0) > 0 || a.gtmContainerId || (a.adsConversionId && a.adsConversionLabel)),
  );
}
