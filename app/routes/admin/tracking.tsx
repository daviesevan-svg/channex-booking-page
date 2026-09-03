import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/tracking";
import { adminMeta } from "~/lib/admin-meta";
import { useAdminT } from "~/lib/admin-i18n";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getSettings, patchSettings } from "~/lib/overrides.server";
import { isTagged, parseAnalyticsForm } from "~/lib/tracking-settings";
import type { ConsentPosture } from "~/lib/content";
import { FIELD_INPUT } from "~/components/admin-form";
import { AdminPageHeader } from "~/components/admin-page-header";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const settings = await getSettings(propertyId);
  return { configured: true as const, analytics: settings.analytics ?? {} };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };
  const { value, errors } = parseAnalyticsForm(await request.formData());
  // Nothing is written when any field failed to parse: a partial save would
  // leave the hotel looking at a form that half-took, with no way to tell which
  // half. They fix the flagged field and save again.
  if (Object.keys(errors).length) return { errors };
  await patchSettings(propertyId, { analytics: value });
  return { ok: true as const };
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "navTracking" });
}

/** The event contract, rendered from data. Event and parameter names are
 *  Google's and ours — never translated, because they are what the hotel's
 *  agency types into GA4 and GTM. */
const EVENTS: { event: string; when: string }[] = [
  { event: "page_view", when: "trkEvPageView" },
  { event: "view_item_list", when: "trkEvViewItemList" },
  { event: "view_item", when: "trkEvViewItem" },
  { event: "add_to_cart", when: "trkEvAddToCart" },
  { event: "remove_from_cart", when: "trkEvRemoveFromCart" },
  { event: "begin_checkout", when: "trkEvBeginCheckout" },
  { event: "purchase", when: "trkEvPurchase" },
];

/** Stay attributes that ride on `purchase` as custom event parameters. GA4 has
 *  no native hotel dimensions, so these are invisible until the hotel registers
 *  them — which is why they are listed here rather than only in our docs. */
const CUSTOM_PARAMS =
  "nights, checkin, checkout, rooms, adults, children, lead_days, room_subtotal, extras_total, due_now, balance_due, promo_code, property_id, payment_type";

function Radio({
  name,
  value,
  checked,
  label,
  desc,
  warn = false,
}: {
  name: string;
  value: ConsentPosture;
  checked: boolean;
  label: string;
  desc: string;
  warn?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-control border border-line-alt bg-surface-alt px-4 py-3">
      <input type="radio" name={name} value={value} defaultChecked={checked} className="mt-1" />
      <span>
        <span className="block text-caption font-semibold text-ink">{label}</span>
        <span className={`block text-micro ${warn ? "text-danger" : "text-muted"}`}>{desc}</span>
      </span>
    </label>
  );
}

export default function AdminTracking({ loaderData, actionData }: Route.ComponentProps) {
  const t = useAdminT();
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  if (!loaderData.configured) {
    return (
      <div className="rounded-panel border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-title-md font-semibold">{t("trkTitle")}</h1>
        <p className="text-body-lg text-secondary">{t("genSetPropertyIdPrefix")}</p>
      </div>
    );
  }

  const a = loaderData.analytics;
  // Uncontrolled inputs keep whatever the hotel typed across a save, so a pasted
  // snippet would still be sitting in the box after we stored the ID out of it —
  // making "we store only the ID" a claim they can't see. Keying on the stored
  // value remounts the field, so a successful save visibly replaces the blob
  // with what we kept.
  const stored = [a.ga4MeasurementIds?.join(","), a.gtmContainerId, a.adsConversionId, a.adsConversionLabel].join("|");
  const errors = actionData && "errors" in actionData ? actionData.errors : undefined;
  const err = (field: string) =>
    errors?.[field] ? <span className="mt-1 block text-micro font-semibold text-danger">{t(errors[field])}</span> : null;

  return (
    <Form method="post" className="max-w-3xl">
      <AdminPageHeader title={t("trkTitle")} saved={Boolean(actionData && "ok" in actionData)} />
      <p className="mb-6 max-w-2xl text-body text-secondary">{t("trkIntro")}</p>

      <section className="mb-6 rounded-panel border border-line bg-surface p-6">
        <div className="mb-1 font-serif text-title-sm font-semibold">{t("trkTagsHeading")}</div>
        <p className="mb-4 text-caption text-muted">{t("trkTagsHint")}</p>

        <div className="flex flex-col gap-4">
          <label className="block text-caption font-semibold text-secondary">
            {t("trkGa4Label")}
            <textarea
              name="ga4"
              key={stored}
              rows={2}
              defaultValue={(a.ga4MeasurementIds ?? []).join("\n")}
              placeholder="G-XXXXXXXXXX"
              className={`${FIELD_INPUT} resize-y font-mono`}
            />
            <span className="mt-1 block text-micro font-normal text-faint">{t("trkGa4Hint")}</span>
            {err("ga4")}
          </label>

          <label className="block text-caption font-semibold text-secondary">
            {t("trkGtmLabel")}
            <input
              name="gtm"
              key={stored}
              defaultValue={a.gtmContainerId ?? ""}
              placeholder="GTM-XXXXXXX"
              className={`${FIELD_INPUT} font-mono`}
            />
            <span className="mt-1 block text-micro font-normal text-faint">{t("trkGtmHint")}</span>
            {err("gtm")}
          </label>

          <div className="rounded-control border border-line-alt p-4">
            <div className="mb-1 text-caption font-semibold text-ink">{t("trkAdsHeading")}</div>
            <p className="mb-3 text-micro text-muted">{t("trkAdsHint")}</p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <label className="block flex-1 text-caption font-semibold text-secondary">
                {t("trkAdsIdLabel")}
                <input
                  name="adsId"
                  key={stored}
                  defaultValue={a.adsConversionId ?? ""}
                  placeholder="AW-123456789"
                  className={`${FIELD_INPUT} font-mono`}
                />
                {err("adsId")}
              </label>
              <label className="block flex-1 text-caption font-semibold text-secondary">
                {t("trkAdsLabelLabel")}
                <input
                  name="adsLabel"
                  key={stored}
                  defaultValue={a.adsConversionLabel ?? ""}
                  placeholder="AbC-D_efGhIjKlMn"
                  className={`${FIELD_INPUT} font-mono`}
                />
                {err("adsLabel")}
              </label>
            </div>
          </div>
        </div>
      </section>

      <section className="mb-6 rounded-panel border border-line bg-surface p-6">
        <div className="mb-1 font-serif text-title-sm font-semibold">{t("trkConsentHeading")}</div>
        <p className="mb-4 text-caption text-muted">{t("trkConsentIntro")}</p>
        <div className="flex flex-col gap-2.5">
          <Radio
            name="consent"
            value="banner"
            checked={(a.consent ?? "banner") === "banner"}
            label={t("trkConsentBanner")}
            desc={t("trkConsentBannerDesc")}
          />
          <Radio
            name="consent"
            value="external"
            checked={a.consent === "external"}
            label={t("trkConsentExternal")}
            desc={t("trkConsentExternalDesc")}
          />
          <Radio
            name="consent"
            value="off"
            checked={a.consent === "off"}
            label={t("trkConsentOff")}
            desc={t("trkConsentOffDesc")}
            warn
          />
        </div>
        {/* The thing every hotel discovers in month two if nobody says it now. */}
        <p className="mt-4 rounded-control bg-surface-alt px-3.5 py-3 text-micro leading-[1.5] text-muted">
          {t("trkDenialNote")}
        </p>
      </section>

      <section className="mb-6 rounded-panel border border-line bg-surface p-6">
        <div className="mb-1 font-serif text-title-sm font-semibold">{t("trkEventsHeading")}</div>
        <p className="mb-4 text-caption text-muted">{t("trkEventsIntro")}</p>
        <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-caption">
          {EVENTS.map((e) => (
            <div key={e.event} className="contents">
              <dt className="font-mono text-ink">{e.event}</dt>
              <dd className="text-muted">{t(e.when)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-micro leading-[1.5] text-muted">
          {t("trkCustomParams")}
          <code className="mt-1 block break-words font-mono text-faint">{CUSTOM_PARAMS}</code>
        </p>
      </section>

      {!isTagged(a) && <p className="mb-4 text-caption text-muted">{t("trkUntagged")}</p>}

      <button
        type="submit"
        disabled={saving}
        className="rounded-control bg-accent px-5 py-2.5 text-caption font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
      >
        {saving ? t("saving") : t("save")}
      </button>
    </Form>
  );
}
