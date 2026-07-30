import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/website";
import { adminMeta } from "~/lib/admin-meta";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, getProperty } from "~/lib/properties.server";
import { getConfig } from "~/lib/config.server";
import { getSettings, patchSettings } from "~/lib/overrides.server";
import { domainError, isWwwSubdomain, normalizeDomain, type DnsVerdict } from "~/lib/domains";
import { checkDns, claimDomain } from "~/lib/domains.server";
import { FIELD_INPUT } from "~/components/admin-form";
import { useAdminT } from "~/lib/admin-i18n";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const [settings, ref] = await Promise.all([getSettings(propertyId), getProperty(propertyId)]);
  const config = getConfig();
  const base = config.appUrl.replace(/\/+$/, "");
  return {
    configured: true as const,
    websiteEnabled: settings.websiteEnabled ?? false,
    websiteDomain: settings.websiteDomain ?? "",
    // The address the site is on today. Slug editing lives on the Properties
    // page — link there rather than growing a second place to change it.
    address: `${base}/${ref?.slug || propertyId}`,
    // Unset on this deployment = custom domains genuinely aren't available, and
    // the page says so instead of printing a target that wouldn't work.
    cnameTarget: config.customHostnameTarget ?? "",
    // So the field validates client-side exactly as the action will.
    ownHost: safeHostname(config.appUrl),
  };
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No property selected." };

  const form = await request.formData();
  const config = getConfig();

  // Both buttons carry `op`; there is deliberately no hidden `op` field, because
  // a hidden input earlier in the form wins over the clicked button's value and
  // every submit would look like a save.
  const domain = normalizeDomain(String(form.get("websiteDomain") ?? ""));

  if (String(form.get("op")) === "checkDns") {
    // Checks what's currently in the box, saved or not — that's what you mean
    // when you've just pasted a domain and want to know if DNS is right.
    return { dns: await checkDns(domain, config.customHostnameTarget ?? "") };
  }

  if (domain) {
    const err = domainError(domain, [safeHostname(config.appUrl)]);
    if (err) return { error: err };
  }

  // Claim the hostname BEFORE saving the setting. A guest arriving on a custom
  // domain is routed by the hostname index, so if the claim fails the setting
  // must not be stored — a property showing a domain it doesn't actually serve
  // is worse than a rejected save.
  const previous = (await getSettings(propertyId)).websiteDomain;
  const claim = await claimDomain(propertyId, domain, previous);
  if (!claim.ok) {
    return {
      error:
        claim.reason === "own_host"
          ? "That's already our own address — enter the hotel's own domain."
          // Deliberately neutral: the index is GLOBAL, so the holder is often
          // another tenant entirely. Naming them, or even saying "on this
          // account", both leaks and misleads.
          : "That domain is already in use.",
    };
  }

  await patchSettings(propertyId, {
    websiteEnabled: form.get("websiteEnabled") === "on",
    // Empty clears it — patchSettings skips `undefined`, so pass "" not undefined.
    websiteDomain: domain,
  });
  return { ok: true as const };
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "webTitle" });
}

export default function AdminWebsite({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const t = useAdminT();

  // Controlled so the DNS record below updates as you type — otherwise you'd
  // have to save before you could see the record you're being asked to create.
  const [typed, setTyped] = useState(
    loaderData.configured ? loaderData.websiteDomain : "",
  );

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("webTitle")}</h1>
        <p className="text-[15px] text-secondary">{t("webAddPropertyFirst")}</p>
      </div>
    );
  }

  const { websiteEnabled, websiteDomain, address, cnameTarget, ownHost } = loaderData;
  const dns = actionData && "dns" in actionData ? actionData.dns : undefined;
  const error = actionData && "error" in actionData ? actionData.error : undefined;
  const cleanTyped = normalizeDomain(typed);
  // Only offer a DNS record once the domain is actually usable — showing one for
  // "notadomain" invites someone to go and create it.
  const typedIsValid = Boolean(cleanTyped) && domainError(cleanTyped, [ownHost]) === null;

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">{t("webTitle")}</h1>
        {actionData && "ok" in actionData && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            {t("saved")}
          </span>
        )}
      </div>
      <p className="mb-6 text-[14px] text-muted">{t("webIntro")}</p>

      {error && (
        <p className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error}
        </p>
      )}

      <Form method="post" className="flex flex-col gap-6 rounded-[14px] border border-line bg-surface p-6">
        {/* --- opt in --- */}
        <div>
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("webEnableTitle")}</div>
          <p className="mb-3 text-[13px] text-muted">{t("webEnableDesc")}</p>
          <label className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3">
            <input
              type="checkbox"
              name="websiteEnabled"
              defaultChecked={websiteEnabled}
              className="mt-1"
            />
            <span>
              <span className="block text-[14px] font-semibold text-ink">{t("webEnableLabel")}</span>
              <span className="block text-[12px] text-muted">{t("webEnableLabelDesc")}</span>
            </span>
          </label>
          <p className="mt-3 rounded-[10px] border border-[#e6dcc4] bg-[#fbf6ea] px-4 py-3 text-[12px] leading-[1.55] text-[#7a6636]">
            {t("webNotBuiltYet")}
          </p>
        </div>

        {/* --- where it lives --- */}
        <div className="border-t border-divider pt-5">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("webAddressTitle")}</div>
          <p className="mb-3 text-[13px] text-muted">{t("webAddressHint")}</p>
          <div className="flex flex-wrap items-center gap-3">
            <code className="min-w-0 flex-1 truncate rounded-[9px] border border-line-alt bg-surface-alt px-3.5 py-2.5 text-[13px] text-ink">
              {address}
            </code>
            <a
              href={address}
              target="_blank"
              rel="noreferrer"
              className="flex-none rounded-[9px] border border-line px-4 py-2.5 text-[13px] font-semibold text-secondary hover:border-accent hover:text-accent"
            >
              {t("webViewSite")}
            </a>
          </div>
          <p className="mt-2 text-[12px] text-faint">
            {t("webSlugHint")}{" "}
            <Link to="/admin/properties" className="font-semibold text-accent hover:underline">
              {t("navProperties")}
            </Link>
          </p>
        </div>

        {/* --- custom domain --- */}
        <div className="border-t border-divider pt-5">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("webDomainTitle")}</div>
          <p className="mb-3 text-[13px] text-muted">{t("webDomainIntro")}</p>
          <label className="block text-[13px] font-semibold text-secondary">
            {t("webDomainLabel")}
            <input
              name="websiteDomain"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="www.yourhotel.com"
              autoComplete="off"
              spellCheck={false}
              className={FIELD_INPUT}
            />
          </label>

          {!cnameTarget ? (
            <p className="mt-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3 text-[12px] leading-[1.55] text-secondary">
              {t("webDomainUnavailable")}
            </p>
          ) : typedIsValid ? (
            <DnsInstructions
              domain={cleanTyped}
              target={cnameTarget}
              t={t}
              busy={busy}
              dns={dns}
            />
          ) : null}
        </div>

        <div>
          <button
            type="submit"
            name="op"
            value="save"
            disabled={busy}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {busy ? t("saving") : t("saveChanges")}
          </button>
        </div>
      </Form>
    </div>
  );
}

function DnsInstructions({
  domain,
  target,
  t,
  busy,
  dns,
}: {
  domain: string;
  target: string;
  t: ReturnType<typeof useAdminT>;
  busy: boolean;
  dns?: DnsVerdict;
}) {
  return (
    <div className="mt-4 rounded-[12px] border border-line-alt bg-surface-alt p-5">
      <div className="mb-1 text-[14px] font-semibold text-ink">{t("webDnsTitle")}</div>
      <p className="mb-3 text-[12px] leading-[1.55] text-muted">{t("webDnsHint")}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        <dt className="text-muted">{t("webDnsType")}</dt>
        <dd className="font-mono text-ink">CNAME</dd>
        <dt className="text-muted">{t("webDnsName")}</dt>
        <dd className="break-all font-mono text-ink">{domain}</dd>
        <dt className="text-muted">{t("webDnsValue")}</dt>
        <dd className="break-all font-mono text-ink">{target}</dd>
      </dl>

      {!isWwwSubdomain(domain) && (
        <p className="mt-3 text-[12px] leading-[1.55] text-muted">{t("webApexNote")}</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/* Its own submit button, not a nested form — nesting forms is invalid
            HTML and the browser drops the inner one silently. */}
        <button
          type="submit"
          name="op"
          value="checkDns"
          disabled={busy}
          className="cursor-pointer rounded-[9px] border border-accent px-4 py-2 text-[13px] font-semibold text-accent hover:bg-accent-soft disabled:opacity-60"
        >
          {busy ? t("webChecking") : t("webCheckDns")}
        </button>
        <span className="text-[12px] text-faint">{t("webCheckDnsHint")}</span>
      </div>

      {dns && <DnsResult dns={dns} target={target} t={t} />}
    </div>
  );
}

function DnsResult({
  dns,
  target,
  t,
}: {
  dns: DnsVerdict;
  target: string;
  t: ReturnType<typeof useAdminT>;
}) {
  const tone =
    dns.kind === "points_here"
      ? "border-[#cfe3d3] bg-[#eef5ef] text-[#3f7a52]"
      : dns.kind === "check_failed"
        ? "border-line-alt bg-surface text-secondary"
        : "border-[#e6dcc4] bg-[#fbf6ea] text-[#7a6636]";

  const body =
    dns.kind === "points_here"
      ? t("webDnsPointsHere")
      : dns.kind === "points_elsewhere"
        ? t("webDnsPointsElsewhere", { found: dns.target, expected: target })
        : dns.kind === "resolves_without_cname"
          ? t("webDnsResolvesNoCname", { addresses: dns.addresses.join(", ") })
          : dns.kind === "not_found"
            ? t("webDnsNotFound")
            : t("webDnsCheckFailed", { reason: dns.reason });

  return (
    <div className={`mt-3 rounded-[10px] border px-4 py-3 text-[12px] leading-[1.55] ${tone}`}>
      {body}
      {dns.kind === "points_here" && (
        <span className="mt-1 block text-[#5c6b5f]">{t("webDnsNotLiveYet")}</span>
      )}
    </div>
  );
}
