// The consent banner, and the only place a guest's choice is written.
//
// Deliberately small: two purposes, three buttons, and a details panel that
// only appears if the guest asks for it. A guest arrived here to book a room —
// every extra control is a decision standing between them and that, and a
// preference centre with six switches for two real purposes is theatre.
//
// Rendered server-side so there is no flash of an unbannered page, and no
// layout shift when it appears.
import { useState } from "react";

import { CONSENT_COOKIE, CONSENT_MAX_AGE_SEC, serializeConsent } from "~/lib/consent";
import type { Translator } from "~/lib/i18n";
import { useSlots } from "~/components/site-style";
import { cx } from "~/lib/site-style";

export interface ConsentDecision {
  analytics: boolean;
  ads: boolean;
}

/** First-party, readable by the server so the banner is decided before render.
 *  Not HttpOnly for the same reason it exists: this script has to write it. */
function writeConsentCookie(choice: ConsentDecision): void {
  const value = serializeConsent({ ...choice, at: Date.now() / 1000 });
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${CONSENT_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${CONSENT_MAX_AGE_SEC}; SameSite=Lax${secure}`;
}

/**
 * One purpose row.
 *
 * Module scope, not nested in ConsentBanner: a component declared inside
 * another is a new type on every render, so React unmounts and remounts the
 * whole group each time a box is ticked — which dropped a second click landing
 * on a node that was being replaced. The guest ticked two boxes and one was
 * saved.
 */
function Toggle({
  checked,
  onChange,
  label,
  desc,
  fixed = false,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  label: string;
  desc: string;
  fixed?: boolean;
}) {
  return (
    <label className="flex items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        disabled={fixed}
        onChange={(e) => onChange?.(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-[var(--accent)] disabled:opacity-60"
      />
      <span className="min-w-0">
        <span className="block text-caption font-semibold text-ink">{label}</span>
        <span className="block text-label leading-[1.45] text-muted-2">{desc}</span>
      </span>
    </label>
  );
}

export function ConsentBanner({
  /** Current choice when reopened from "Cookie settings" — the panel opens on
   *  what they picked last time, not on a blank slate. */
  current,
  onChoice,
  privacyUrl,
  tr,
}: {
  current?: ConsentDecision;
  onChoice: (choice: ConsentDecision) => void;
  privacyUrl?: string;
  /** Passed in, not from useT(): this banner is mounted by the layout itself
   *  rather than inside the <Outlet>, and useProperty() reads the OUTLET
   *  context — so useT() here silently resolves to English and a German guest
   *  gets a German page with an English consent notice. */
  tr: Translator;
}) {
  const s = useSlots();
  const [detail, setDetail] = useState(Boolean(current));
  const [analytics, setAnalytics] = useState(current?.analytics ?? true);
  const [ads, setAds] = useState(current?.ads ?? true);

  const choose = (choice: ConsentDecision) => {
    writeConsentCookie(choice);
    onChoice(choice);
  };

  return (
    <div
      // A dialog, not an alert: it is not an emergency, and aria-modal would be
      // a lie — the page behind stays usable, which is deliberate. Nothing
      // third-party has loaded yet, so browsing on without answering is safe.
      role="dialog"
      aria-label={tr.t("ccTitle")}
      className="fixed inset-x-0 bottom-0 z-[60] p-3 sm:p-4"
    >
      <div className={cx("mx-auto max-w-[640px]", s.strip, "p-5")} style={{ boxShadow: "var(--shadow-sticky)" }}>
        <div className="mb-1.5 text-body font-semibold text-ink">{tr.t("ccTitle")}</div>
        <p className="mb-3.5 text-caption leading-[1.5] text-secondary">
          {tr.t("ccBody")}{" "}
          {privacyUrl && (
            <a href={privacyUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-accent">
              {tr.t("privacyLink")}
            </a>
          )}
        </p>

        {detail && (
          <div className="mb-4 flex flex-col gap-3 border-t border-[var(--line)] pt-3.5">
            <Toggle checked fixed label={tr.t("ccNecessary")} desc={tr.t("ccNecessaryDesc")} />
            <Toggle checked={analytics} onChange={setAnalytics} label={tr.t("ccAnalytics")} desc={tr.t("ccAnalyticsDesc")} />
            <Toggle checked={ads} onChange={setAds} label={tr.t("ccAds")} desc={tr.t("ccAdsDesc")} />
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            onClick={() => (detail ? choose({ analytics, ads }) : choose({ analytics: true, ads: true }))}
            className={cx("flex-1", s.btnPrimary, "px-4 py-2.5 text-caption font-semibold")}
          >
            {detail ? tr.t("ccSave") : tr.t("ccAcceptAll")}
          </button>
          <button
            type="button"
            onClick={() => choose({ analytics: false, ads: false })}
            className={cx("flex-1", s.btnSecondary, "px-4 py-2.5 text-caption font-semibold")}
          >
            {tr.t("ccRejectAll")}
          </button>
          {!detail && (
            <button
              type="button"
              onClick={() => setDetail(true)}
              className="px-2 py-2.5 text-caption font-medium text-muted underline hover:text-accent sm:flex-none"
            >
              {tr.t("ccConfigure")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
