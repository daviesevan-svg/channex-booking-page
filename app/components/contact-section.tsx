// Contact section: the property's own details, and optionally a form that
// emails the hotel.
//
// The details half is the part that always works — a phone number and an email
// address are how most guests actually get in touch, and both are plain links.
// The form is a convenience on top, and it hides itself when there's nowhere to
// deliver to rather than swallowing messages.

import { useFetcher } from "react-router";

import type { Translator } from "~/lib/i18n";
import { Diamond } from "~/components/sections";
import { RichText } from "~/components/rich-text";

const FIELD =
  "mt-1.5 w-full rounded-[10px] border border-line bg-surface px-3.5 py-2.5 text-[15px] text-ink outline-none focus:border-accent";

export interface ContactDetails {
  address?: string;
  phone?: string;
  email?: string;
  checkinTime?: string;
  checkoutTime?: string;
}

export function ContactSection({
  heading,
  intro,
  details,
  showForm,
  channelId,
  tr,
}: {
  heading: string;
  intro?: string;
  details: ContactDetails;
  showForm: boolean;
  channelId: string;
  tr: Translator;
}) {
  const hasDetails = Boolean(
    details.address || details.phone || details.email || details.checkinTime,
  );
  if (!hasDetails && !showForm) return null;

  return (
    <div className="mt-12 scroll-mt-24" id="contact">
      <h2 className="mb-2 font-serif text-[24px] font-semibold">{heading}</h2>
      {intro && (
        <div className="mb-6 max-w-[620px]">
          <RichText text={intro} className="text-[15px] leading-[1.6] text-muted" />
        </div>
      )}

      <div
        className={`grid grid-cols-1 gap-10 ${showForm ? "lg:grid-cols-[1fr_1.2fr]" : "max-w-[620px]"}`}
      >
        {hasDetails && (
          <dl className="flex flex-col gap-4 text-[15px]">
            {details.address && (
              <Row label={tr.t("contactAddress")}>
                <span className="whitespace-pre-line">{details.address}</span>
              </Row>
            )}
            {details.phone && (
              <Row label={tr.t("contactPhone")}>
                <a href={`tel:${details.phone.replace(/\s+/g, "")}`} className="hover:text-accent">
                  {details.phone}
                </a>
              </Row>
            )}
            {details.email && (
              <Row label={tr.t("contactEmail")}>
                <a href={`mailto:${details.email}`} className="break-all hover:text-accent">
                  {details.email}
                </a>
              </Row>
            )}
            {details.checkinTime && (
              <Row label={tr.t("contactTimes")}>
                <span>
                  {tr.t("contactCheckinFrom", { time: details.checkinTime })}
                  {details.checkoutTime
                    ? ` · ${tr.t("contactCheckoutBy", { time: details.checkoutTime })}`
                    : ""}
                </span>
              </Row>
            )}
          </dl>
        )}

        {showForm && <ContactForm channelId={channelId} tr={tr} />}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <Diamond className="mt-[7px]" size={7} />
      <div>
        <dt className="text-[12px] font-semibold uppercase tracking-wide text-muted-2">{label}</dt>
        <dd className="mt-0.5 leading-[1.55] text-secondary">{children}</dd>
      </div>
    </div>
  );
}

function ContactForm({ channelId, tr }: { channelId: string; tr: Translator }) {
  const fetcher = useFetcher<{ ok?: true; error?: string }>();
  const sending = fetcher.state !== "idle";
  const result = fetcher.data;

  if (result?.ok) {
    return (
      <div className="rounded-[14px] border border-[#cfe3d3] bg-[#eef5ef] p-6">
        <p className="text-[15px] font-semibold text-[#3f7a52]">{tr.t("contactSentTitle")}</p>
        <p className="mt-1 text-[14px] leading-[1.55] text-[#4a6b52]">{tr.t("contactSentBody")}</p>
      </div>
    );
  }

  const errorText = result?.error
    ? tr.t(
        result.error === "throttled"
          ? "contactThrottled"
          : result.error === "email"
            ? "contactBadEmail"
            : result.error === "missing"
              ? "contactMissing"
              : result.error === "unavailable"
                ? "contactUnavailable"
                : "contactFailed",
      )
    : null;

  return (
    <fetcher.Form
      method="post"
      action={`/${channelId}/contact`}
      className="rounded-[14px] border border-line bg-surface p-6"
    >
      {/* Honeypot. Hidden from people, irresistible to bots; a filled value is
          accepted and dropped server-side. */}
      <div className="absolute h-0 w-0 overflow-hidden" aria-hidden>
        <label>
          Website
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block text-[13px] font-semibold text-secondary">
          {tr.t("contactYourName")}
          <input name="name" required maxLength={100} autoComplete="name" className={FIELD} />
        </label>
        <label className="block text-[13px] font-semibold text-secondary">
          {tr.t("contactYourEmail")}
          <input
            name="email"
            type="email"
            required
            maxLength={200}
            autoComplete="email"
            className={FIELD}
          />
        </label>
      </div>
      <label className="mt-4 block text-[13px] font-semibold text-secondary">
        {tr.t("contactMessage")}
        <textarea name="message" required rows={5} maxLength={2000} className={FIELD} />
      </label>

      {errorText && <p className="mt-3 text-[13px] font-medium text-red-600">{errorText}</p>}

      <button
        type="submit"
        disabled={sending}
        className="mt-4 cursor-pointer rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
      >
        {sending ? tr.t("contactSending") : tr.t("contactSend")}
      </button>
    </fetcher.Form>
  );
}
