import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/website";
import { adminMeta } from "~/lib/admin-meta";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, getProperty } from "~/lib/properties.server";
import { getConfig } from "~/lib/config.server";
import { getSettings, patchSettings } from "~/lib/overrides.server";
import { domainError, isWwwSubdomain, normalizeDomain, type DnsVerdict } from "~/lib/domains";
import {
  activateDomain,
  checkDns,
  claimDomainSetup,
  domainSetupOwner,
  propertyIdForHost,
  releaseDomain,
} from "~/lib/domains.server";
import {
  deleteCustomHostname,
  ensureCustomHostname,
  findCustomHostname,
  provisioningConfigured,
  type ProvisionState,
} from "~/lib/custom-hostnames.server";
import { FIELD_INPUT } from "~/components/admin-form";
import { useAdminT } from "~/lib/admin-i18n";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const [settings, ref] = await Promise.all([getSettings(propertyId), getProperty(propertyId)]);
  const config = getConfig();
  const base = config.appUrl.replace(/\/+$/, "");
  const domain = settings.websiteDomain ?? "";

  // Read-only: the loader never creates a hostname, so refreshing the page can't
  // provision anything. Registration happens on save and on "Check status".
  const [provision, liveOwner] = await Promise.all([
    domain && provisioningConfigured()
      ? findCustomHostname(domain)
      : Promise.resolve<ProvisionState>(provisioningConfigured() ? { kind: "missing" } : { kind: "off" }),
    domain ? propertyIdForHost(domain) : Promise.resolve(null),
  ]);

  return {
    configured: true as const,
    websiteEnabled: settings.websiteEnabled ?? false,
    websiteDomain: domain,
    provision,
    /** The index actually points this hostname at us — i.e. it serves the site. */
    live: liveOwner === propertyId,
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

  const op = String(form.get("op"));

  if (op === "checkDns") {
    // Checks what's currently in the box, saved or not — that's what you mean
    // when you've just pasted a domain and want to know if DNS is right.
    return { dns: await checkDns(domain, config.customHostnameTarget ?? "") };
  }

  if (op === "provision") return finishActivation(propertyId);

  if (domain) {
    const err = domainError(domain, [safeHostname(config.appUrl)]);
    if (err) return { error: err };
  }

  // Reserve the hostname BEFORE saving the setting. A guest arriving on a custom
  // domain is routed by the hostname index, so if the claim fails the setting
  // must not be stored — a property showing a domain it doesn't actually serve
  // is worse than a rejected save.
  const previous = (await getSettings(propertyId)).websiteDomain;
  const claim = await claimDomainSetup(propertyId, domain);
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

  // Only now let go of the old hostname. Releasing first would take a working
  // domain down on a save that then gets REJECTED, which is the worse failure;
  // this order can at worst strand the old claim, which re-saving clears.
  if (previous && previous !== domain) {
    const released = await releaseDomain(propertyId, previous);
    // `released` is the authority to touch Cloudflare: the stored domain may name
    // a hostname this property never held, and deleting on that basis would take
    // the real holder's site down.
    if (released) await deleteCustomHostname(previous).catch(() => {});
  }

  await patchSettings(propertyId, {
    websiteEnabled: form.get("websiteEnabled") === "on",
    // Empty clears it — patchSettings skips `undefined`, so pass "" not undefined.
    websiteDomain: domain,
  });

  // Register with Cloudflare in the same submit, so the records the hotel has to
  // create are on screen without them having to press anything else.
  if (domain) return { ok: true as const, ...(await finishActivation(propertyId)) };
  return { ok: true as const };
}

/**
 * Register the saved domain with Cloudflare and, if Cloudflare has since proven
 * the hotel controls it, switch it on.
 *
 * Also what the "Check status" button runs. Activation is idempotent, so pressing
 * it on a live domain just re-reads the certificate state.
 */
async function finishActivation(propertyId: string) {
  const domain = (await getSettings(propertyId)).websiteDomain ?? "";
  if (!domain) return { provision: { kind: "off" } as ProvisionState, live: false };

  // Defence in depth: settings could name a hostname this property doesn't hold
  // (that's how the clone bug leaked one), and provisioning it would let a tenant
  // drive setup for someone else's domain.
  const [owner, liveOwner] = await Promise.all([
    domainSetupOwner(domain),
    propertyIdForHost(domain),
  ]);
  if (owner && owner !== propertyId && liveOwner !== propertyId) {
    return { provision: { kind: "off" } as ProvisionState, live: false, error: "That domain is already in use." };
  }

  const provision = await ensureCustomHostname(domain);
  let live = liveOwner === propertyId;
  if (provision.kind === "hostname" && provision.verified && !live) {
    const claim = await activateDomain(propertyId, domain);
    live = claim.ok;
    if (!claim.ok) return { provision, live, error: "That domain is already in use." };
  }
  return { provision, live };
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
  // A submit that touched provisioning knows more than the loader did.
  const provision =
    actionData && "provision" in actionData && actionData.provision
      ? actionData.provision
      : loaderData.provision;
  const live =
    actionData && "live" in actionData && typeof actionData.live === "boolean"
      ? actionData.live
      : loaderData.live;
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

          {cnameTarget && websiteDomain && (
            <Activation
              domain={websiteDomain}
              unsaved={cleanTyped !== websiteDomain}
              state={provision}
              live={live}
              busy={busy}
              t={t}
            />
          )}
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

const TONE = {
  ok: "border-[#cfe3d3] bg-[#eef5ef] text-[#3f7a52]",
  wait: "border-[#e6dcc4] bg-[#fbf6ea] text-[#7a6636]",
  plain: "border-line-alt bg-surface text-secondary",
};

function Note({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  return (
    <div className={`mt-3 rounded-[10px] border px-4 py-3 text-[12px] leading-[1.55] ${TONE[tone]}`}>
      {children}
    </div>
  );
}

/**
 * Activation: what Cloudflare currently thinks of the saved domain.
 *
 * Separate from the CNAME block above on purpose. That block is the record the
 * hotel adds whenever they like; this one is a live state machine, and conflating
 * them made "I added the record, why isn't it working?" impossible to answer.
 *
 * There is deliberately nothing to do here beyond the CNAME — ownership and the
 * certificate both validate themselves once it's in place (see
 * custom-hostnames.server.ts). This panel exists to say how far along that is.
 */
function Activation({
  domain,
  unsaved,
  state,
  live,
  busy,
  t,
}: {
  domain: string;
  unsaved: boolean;
  state: ProvisionState;
  live: boolean;
  busy: boolean;
  t: ReturnType<typeof useAdminT>;
}) {
  return (
    <div className="mt-4 rounded-[12px] border border-line-alt bg-surface-alt p-5">
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <span className="text-[14px] font-semibold text-ink">{t("webProvTitle")}</span>
        <code className="min-w-0 truncate text-[12px] text-muted">{domain}</code>
        {live && (
          <span className="ml-auto flex-none rounded-full bg-[#e8f0e6] px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.04em] text-[#3f7a52]">
            {t("webProvLivePill")}
          </span>
        )}
      </div>
      <p className="text-[12px] leading-[1.55] text-muted">{t("webProvIntro")}</p>

      {unsaved ? (
        <Note tone="plain">{t("webProvSaveFirst")}</Note>
      ) : state.kind === "off" ? (
        <Note tone="wait">{t("webProvOff")}</Note>
      ) : state.kind === "error" ? (
        <Note tone="plain">{t("webProvError", { message: state.message })}</Note>
      ) : state.kind === "missing" ? (
        <Note tone="plain">{t("webProvNotStarted")}</Note>
      ) : (
        <>
          {live ? (
            <Note tone="ok">{t("webProvLive")}</Note>
          ) : state.verified ? (
            <Note tone="wait">{t("webProvVerifiedNotLive")}</Note>
          ) : (
            <Note tone="wait">{t("webProvWaiting")}</Note>
          )}

          {!state.certReady && (
            <Note tone="plain">{t("webProvCertPending", { status: state.certStatus })}</Note>
          )}

          {state.problems.length > 0 && (
            <Note tone="wait">{t("webProvProblem", { problems: state.problems.join("; ") })}</Note>
          )}
        </>
      )}

      {!unsaved && state.kind !== "off" && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            name="op"
            value="provision"
            disabled={busy}
            className="cursor-pointer rounded-[9px] border border-accent px-4 py-2 text-[13px] font-semibold text-accent hover:bg-accent-soft disabled:opacity-60"
          >
            {busy ? t("webProvChecking") : t("webProvCheck")}
          </button>
          <span className="text-[12px] text-faint">{t("webProvCheckHint")}</span>
        </div>
      )}
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
