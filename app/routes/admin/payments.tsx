import { useState, type ReactNode } from "react";
import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/payments";
import { adminMeta } from "~/lib/admin-meta";
import { SavedPill } from "~/components/admin-page-header";
import { requireAdmin, stampStripeConnectState } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getConfig } from "~/lib/config.server";
import { getIyzicoConfig, getSettings, getVivaConfig, savePaymentSettings, saveIyzicoConfig, saveVivaConfig } from "~/lib/overrides.server";
import { getProperty } from "~/lib/properties.server";
import { guestHostForProperty } from "~/lib/partners.server";
import { deauthorize, oauthAuthorizeUrl, retrieveAccount } from "~/lib/stripe.server";
import { runVivaDiagnostics, verifyVivaConfig, VIVA_CURRENCIES } from "~/lib/viva.server";
import { IYZICO_CURRENCIES, verifyIyzicoConfig } from "~/lib/iyzico.server";
import { saveVivaDiagnostics } from "~/lib/viva-diag.server";
import { redirect } from "react-router";
import { useAdminT } from "~/lib/admin-i18n";

export async function loader({ request }: Route.LoaderArgs) {
  const email = await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const settings = await getSettings(propertyId);
  const property = await getProperty(propertyId);
  // Pull live account details so the operator can see exactly which Stripe
  // account is connected (and a stale charges flag self-heals on view).
  let account: { name?: string; email?: string; country?: string; currency?: string; chargesEnabled: boolean } | null = null;
  if (settings.stripeAccountId) {
    const a = await retrieveAccount(settings.stripeAccountId).catch(() => null);
    if (a) {
      account = {
        name: a.business_profile?.name ?? undefined,
        email: a.email ?? undefined,
        country: a.country ?? undefined,
        currency: a.default_currency ? a.default_currency.toUpperCase() : undefined,
        chargesEnabled: a.charges_enabled ?? false,
      };
    }
  }

  // Viva connection status — only non-secret fields ever leave the loader.
  const viva = await getVivaConfig(propertyId);
  const iyzico = await getIyzicoConfig(propertyId);
  // The URLs the operator pastes into their Viva account. They follow the
  // PROPERTY's guest host (a partner's hotel lives on the partner's domain);
  // /viva/return|failure are root-level and find the checkout by order code,
  // and the webhook is keyed by property id, so any of our hosts would work —
  // but the guest should come back to the site they booked on.
  const url = new URL(request.url);
  const guestHost = await guestHostForProperty(property?.partnerId, email);
  const guestOrigin = guestHost ? `${url.protocol}//${guestHost}${url.port ? `:${url.port}` : ""}` : url.origin;
  const currency = (settings.currency || "GBP").toUpperCase();

  return {
    configured: true as const,
    propertyName: property?.name,
    platformReady: Boolean(getConfig().stripeConnectClientId),
    secretReady: Boolean(getConfig().stripeSecretKey),
    accountId: settings.stripeAccountId,
    chargesEnabled: account?.chargesEnabled ?? settings.stripeChargesEnabled ?? false,
    account,
    notice: new URL(request.url).searchParams.get("stripe") || undefined,
    viva: viva
      ? { merchantId: viva.merchantId, sourceCode: viva.sourceCode, demo: Boolean(viva.demo), isv: Boolean(viva.isv) }
      : null,
    vivaUrls: {
      success: `${guestOrigin}/viva/return`,
      failure: `${guestOrigin}/viva/failure`,
      webhook: `${guestOrigin}/api/viva-webhook/${propertyId}`,
    },
    currency,
    vivaCurrencyOk: VIVA_CURRENCIES.has(currency),
    // Only the non-secret half ever leaves the loader — same rule as Viva. The
    // secret key is write-only from here: it goes in, it never comes back out.
    iyzico: iyzico ? { merchantId: iyzico.merchantId ?? "", sandbox: Boolean(iyzico.sandbox) } : null,
    iyzicoCurrencyOk: IYZICO_CURRENCIES.has(currency),
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "Add a property first." };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // Re-run the real token + probe-order exchange against Viva and show the raw
  // result — exactly what Viva support asks for (endpoints, token scope, order
  // payload, their response) when an order creation misbehaves.
  if (intent === "viva-diagnostics") {
    const viva = await getVivaConfig(propertyId);
    if (!viva) return { error: "Viva isn't connected on this property." };
    const report = await runVivaDiagnostics(viva);
    await saveVivaDiagnostics(propertyId, report);
    return { vivaDiag: report };
  }

  if (intent === "disconnect") {
    const settings = await getSettings(propertyId);
    if (settings.stripeAccountId) await deauthorize(settings.stripeAccountId).catch(() => {});
    await savePaymentSettings(propertyId, {});
    return { ok: true };
  }

  if (intent === "connect") {
    if (!getConfig().stripeConnectClientId) return { error: "Stripe is not configured on the platform yet." };
    // One gateway per property: a Viva connection must be removed explicitly
    // before Stripe takes over, so charges never silently switch rails.
    if (await getVivaConfig(propertyId)) return { error: "Disconnect Viva first — a property charges through one gateway." };
    if (await getIyzicoConfig(propertyId)) return { error: "Disconnect iyzico first — a property charges through one gateway." };
    // One-time nonce in the admin session, bound to this property. The raw
    // property id is not secret and must not be OAuth `state` — SameSite=Lax
    // sends the session cookie on the top-level GET callback.
    const redirectUri = `${new URL(request.url).origin}/admin/payments/callback`;
    const { nonce, cookie } = await stampStripeConnectState(request, propertyId);
    throw redirect(oauthAuthorizeUrl(nonce, redirectUri), {
      headers: { "Set-Cookie": cookie },
    });
  }

  if (intent === "viva-connect") {
    const settings = await getSettings(propertyId);
    if (settings.stripeAccountId) return { error: "Disconnect Stripe first — a property charges through one gateway." };
    if (await getIyzicoConfig(propertyId)) return { error: "Disconnect iyzico first — a property charges through one gateway." };
    const currency = (settings.currency || "GBP").toUpperCase();
    if (!VIVA_CURRENCIES.has(currency)) {
      return { error: `Viva Smart Checkout doesn't support ${currency}. Supported: ${[...VIVA_CURRENCIES].join(", ")}.` };
    }
    const config = {
      merchantId: String(form.get("merchantId") ?? "").trim(),
      apiKey: String(form.get("apiKey") ?? "").trim(),
      clientId: String(form.get("clientId") ?? "").trim(),
      clientSecret: String(form.get("clientSecret") ?? "").trim(),
      sourceCode: String(form.get("sourceCode") ?? "").trim(),
      demo: form.get("demo") === "on",
      isv: form.get("isv") === "on",
    };
    if (!config.merchantId || !config.apiKey || !config.clientId || !config.clientSecret || !config.sourceCode) {
      return { error: "All five Viva credentials are required." };
    }
    // Exercise both credential pairs against Viva before storing anything — a
    // typo'd secret must fail HERE, not at a guest's first checkout. On failure,
    // attach the full diagnostics report: this is the state Viva support tickets
    // are written from, and the connected card's diagnostics button doesn't
    // exist yet because the connect never succeeded.
    const problem = await verifyVivaConfig(config);
    if (problem) {
      // Persist the report too: the failed attempt is usually made by the
      // hotel, and the support ticket gets written later without their screen.
      const report = await runVivaDiagnostics(config);
      await saveVivaDiagnostics(propertyId, report);
      return { error: problem, vivaDiag: report };
    }
    await saveVivaConfig(propertyId, config);
    return { ok: true };
  }

  if (intent === "viva-disconnect") {
    await saveVivaConfig(propertyId, null);
    return { ok: true };
  }

  if (intent === "iyzico-connect") {
    const settings = await getSettings(propertyId);
    if (settings.stripeAccountId) return { error: "Disconnect Stripe first — a property charges through one gateway." };
    if (await getVivaConfig(propertyId)) return { error: "Disconnect Viva first — a property charges through one gateway." };
    const currency = (settings.currency || "GBP").toUpperCase();
    if (!IYZICO_CURRENCIES.has(currency)) {
      return { error: `iyzico doesn't support ${currency}. Supported: ${[...IYZICO_CURRENCIES].join(", ")}.` };
    }
    const config = {
      apiKey: String(form.get("apiKey") ?? "").trim(),
      secretKey: String(form.get("secretKey") ?? "").trim(),
      merchantId: String(form.get("merchantId") ?? "").trim() || undefined,
      sandbox: form.get("sandbox") === "on",
    };
    if (!config.apiKey || !config.secretKey) return { error: "Both the API key and the secret key are required." };
    // Exercised against iyzico before anything is stored: a mistyped secret has
    // to fail here, not at a guest's first checkout. Their auth failures come
    // back as a business error, so the message is theirs and specific
    // ("Invalid signature").
    const problem = await verifyIyzicoConfig(config);
    if (problem) return { error: problem };
    await saveIyzicoConfig(propertyId, config);
    return { ok: true };
  }

  if (intent === "iyzico-disconnect") {
    await saveIyzicoConfig(propertyId, null);
    return { ok: true };
  }
  return { error: "Unknown action." };
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "navPayments" });
}

/** A credential field. Monospaced on purpose: everything typed here is a
 *  pasted key, id or code, and a transposed character is invisible in
 *  proportional text. Shared by Viva and iyzico. */
function CredField({ name, label, placeholder }: { name: string; label: string; placeholder?: string }) {
  return (
    <label className="block text-[12px] font-semibold text-secondary">
      {label}
      <input
        name={name}
        type="text"
        autoComplete="off"
        placeholder={placeholder}
        className="mt-1 block w-full rounded-[10px] border border-line-alt bg-surface px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent"
      />
    </label>
  );
}

function UrlRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="break-all font-mono text-[11px] text-ink">{value}</dd>
    </>
  );
}

/** A row in one of the connected panels' detail lists. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </>
  );
}

const DETAIL_LIST = "mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 border-t border-divider pt-4 text-[13px]";
const PRIMARY_BUTTON =
  "rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60";
const QUIET_BUTTON =
  "rounded-[10px] border border-line-alt bg-surface px-4 py-2.5 text-[14px] font-semibold text-secondary hover:border-accent hover:text-accent disabled:opacity-60";

function OkBadge({ children }: { children: ReactNode }) {
  return (
    <span className="flex-none rounded-full bg-[#e8f0e6] px-2.5 py-1 text-[11px] font-semibold text-[#3f7a52]">
      {children}
    </span>
  );
}

function WarnBadge({ children }: { children: ReactNode }) {
  return (
    <span className="flex-none rounded-full bg-[#fbeede] px-2.5 py-1 text-[11px] font-semibold text-[#9a6a1e]">
      {children}
    </span>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 rounded-[10px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12px] leading-[1.5] text-amber-800">
      {children}
    </p>
  );
}

/** The card chrome every provider shares: name, one-line description and an
 *  optional status badge, over whatever body the state calls for. */
function Panel({
  name,
  desc,
  badge,
  children,
}: {
  name: string;
  desc: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[14px] border border-line bg-surface p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-serif text-[18px] font-semibold">{name}</div>
          <div className="mt-0.5 text-[12px] leading-[1.5] text-muted">{desc}</div>
        </div>
        {badge}
      </div>
      {children}
    </section>
  );
}

type ProviderId = "stripe" | "viva" | "iyzico";

/** Name and blurb per provider. Order is the order of the chooser. */
const PROVIDERS: { id: ProviderId; name: string; descKey: string }[] = [
  { id: "stripe", name: "Stripe", descKey: "payStripeDesc" },
  { id: "viva", name: "Viva", descKey: "payVivaDesc" },
  { id: "iyzico", name: "iyzico", descKey: "payIyzicoDesc" },
];

/** One provider in the chooser. A radio, not a button: a property charges
 *  through exactly one gateway, so the control should say so. `blocker` is the
 *  reason this provider can't be picked (wrong currency, platform not set up)
 *  and replaces the blurb — the reason belongs on the thing it disqualifies,
 *  not in a banner above three cards. */
function ProviderTile({
  name,
  desc,
  blocker,
  selected,
  onSelect,
}: {
  name: string;
  desc: string;
  blocker?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`flex items-start gap-3 rounded-[14px] border bg-surface p-4 ${
        blocker
          ? "cursor-not-allowed border-line opacity-60"
          : `cursor-pointer ${selected ? "border-accent ring-1 ring-accent" : "border-line hover:border-line-alt"}`
      }`}
    >
      <input
        type="radio"
        name="gateway"
        checked={selected}
        disabled={Boolean(blocker)}
        onChange={onSelect}
        className="mt-1 h-4 w-4 flex-none border-line-alt text-accent focus:ring-accent"
      />
      <span className="min-w-0">
        <span className="block font-serif text-[17px] font-semibold text-ink">{name}</span>
        <span className={`mt-0.5 block text-[12px] leading-[1.5] ${blocker ? "text-amber-800" : "text-muted"}`}>
          {blocker ?? desc}
        </span>
      </span>
    </label>
  );
}

export default function AdminPayments({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const t = useAdminT();

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("payTitle")}</h1>
        <p className="text-[15px] text-secondary">{t("payNotConfigured")}</p>
      </div>
    );
  }

  const { propertyName, platformReady, secretReady, accountId, chargesEnabled, account, notice, viva, vivaUrls, currency, vivaCurrencyOk, iyzico, iyzicoCurrencyOk } = loaderData;

  // Exactly one of these can be set: the action refuses a second gateway.
  const active: ProviderId | null = accountId ? "stripe" : viva ? "viva" : iyzico ? "iyzico" : null;

  // Which provider's setup form is open. Nothing is open until the operator
  // picks one — three credential forms stacked open was the whole problem.
  const [choice, setChoice] = useState<ProviderId | null>(null);

  // Why a provider can't be picked, if it can't. Undefined means available.
  const blockers: Record<ProviderId, string | undefined> = {
    stripe: platformReady ? undefined : t("payPlatformMissing"),
    viva: vivaCurrencyOk ? undefined : t("payVivaCurrency", { currency }),
    iyzico: iyzicoCurrencyOk ? undefined : t("payIyzicoCurrency", { currency }),
  };

  const NOTICES: Record<string, { ok: boolean; text: string }> = {
    connected: { ok: true, text: t("payNoticeConnected") },
    denied: { ok: false, text: t("payNoticeDenied") },
    mismatch: { ok: false, text: t("payNoticeMismatch") },
    error: { ok: false, text: t("payNoticeError") },
  };
  const banner = notice ? NOTICES[notice] : undefined;

  const disconnect = (intent: string) => (
    <Form method="post">
      <input type="hidden" name="intent" value={intent} />
      <button type="submit" disabled={busy} className={QUIET_BUTTON}>
        {t("payDisconnect")}
      </button>
    </Form>
  );

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="font-serif text-[26px] font-semibold">{t("payTitle")}</h1>
          {propertyName && (
            <p className="mt-0.5 text-[13px] text-muted">
              {t("payConnectingFor")} <span className="font-semibold text-secondary">{propertyName}</span>
            </p>
          )}
        </div>
        <SavedPill show={Boolean(actionData?.ok)} />
      </div>

      {/* One column, one width. The old three-abreast layout wrapped into a
          ragged row because the cards' natural heights differ by a factor of
          five — a Stripe button against Viva's five credential fields. */}
      <div className="max-w-3xl">
        <p className="mb-5 text-[14px] leading-[1.6] text-secondary">{t("payIntro")}</p>

        {banner && (
          <p
            className={`mb-4 rounded-[10px] border px-4 py-2.5 text-[13px] ${
              banner.ok ? "border-[#cfe3d0] bg-[#eef5ec] text-[#3f7a52]" : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {banner.ok ? "✓ " : ""}
            {banner.text}
          </p>
        )}

        {platformReady && !secretReady && (
          <p className="mb-4 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-2.5 text-[12px] leading-[1.5] text-amber-800">
            {t("paySecretMissingBefore")}
            <code className="mx-1 rounded bg-white/60 px-1">STRIPE_SECRET_KEY</code>
            {t("paySecretMissingAfter")}
          </p>
        )}

        {actionData?.error && (
          <p className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] leading-[1.5] text-red-700">
            {actionData.error}
          </p>
        )}

        {/* ---- Connected: one panel for the gateway that's live ---- */}
        {active === "stripe" && (
          <Panel
            name="Stripe"
            desc={t("payStripeDesc")}
            badge={chargesEnabled ? <OkBadge>{t("payConnected")}</OkBadge> : <WarnBadge>{t("payConnectedFinishSetup")}</WarnBadge>}
          >
            <dl className={DETAIL_LIST}>
              {account?.name && <DetailRow label={t("payAccount")}><span className="font-semibold">{account.name}</span></DetailRow>}
              <DetailRow label={t("payAccountId")}>
                <span className="font-mono text-[12px]">{accountId}</span>
              </DetailRow>
              {account?.email && <DetailRow label={t("payEmail")}>{account.email}</DetailRow>}
              {(account?.country || account?.currency) && (
                <DetailRow label={t("payCountryCurrency")}>
                  {[account?.country, account?.currency].filter(Boolean).join(" · ")}
                </DetailRow>
              )}
              <dt className="text-muted">{t("payCharges")}</dt>
              <dd className={chargesEnabled ? "font-semibold text-[#3f7a52]" : "font-semibold text-[#9a6a1e]"}>
                {chargesEnabled ? t("payEnabled") : t("payNotEnabledYet")}
              </dd>
            </dl>

            {!chargesEnabled && <p className="mt-3 text-[13px] leading-[1.6] text-secondary">{t("payFinishOnboarding")}</p>}
            {!platformReady && <Note>{t("payPlatformMissing")}</Note>}

            <div className="mt-5">{disconnect("disconnect")}</div>
          </Panel>
        )}

        {active === "viva" && viva && (
          <Panel
            name="Viva"
            desc={t("payVivaDesc")}
            badge={<OkBadge>{viva.demo ? t("payVivaConnectedDemo") : t("payConnected")}</OkBadge>}
          >
            <dl className={DETAIL_LIST}>
              <DetailRow label={t("payVivaMerchantId")}>
                <span className="font-mono text-[12px]">{viva.merchantId}</span>
              </DetailRow>
              <DetailRow label={t("payVivaSourceCode")}>
                <span className="font-mono text-[12px]">{viva.sourceCode}</span>
              </DetailRow>
              <DetailRow label={t("payVivaEnvironment")}>{viva.demo ? t("payVivaEnvDemo") : t("payVivaEnvLive")}</DetailRow>
              <DetailRow label={t("payVivaModel")}>{viva.isv ? t("payVivaModelIsv") : t("payVivaModelMerchant")}</DetailRow>
            </dl>

            <div className="mt-4 rounded-[10px] border border-line bg-canvas p-3.5">
              <p className="mb-2 text-[12px] font-semibold text-secondary">{t("payVivaUrlsTitle")}</p>
              <p className="mb-3 text-[12px] leading-[1.5] text-muted">{t("payVivaUrlsHelp")}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
                <UrlRow label={t("payVivaSuccessUrl")} value={vivaUrls.success} />
                <UrlRow label={t("payVivaFailureUrl")} value={vivaUrls.failure} />
                <UrlRow label={t("payVivaWebhookUrl")} value={vivaUrls.webhook} />
              </dl>
              <p className="mt-3 text-[12px] leading-[1.5] text-muted">{t("payVivaWebhookSteps")}</p>
              <p className="mt-2 rounded-[8px] border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-[1.5] text-amber-900">
                {t("payVivaWebhookVerifyNote")}
              </p>
            </div>

            <p className="mt-3 text-[12px] leading-[1.5] text-muted-2">{t("payVivaNoGuarantee")}</p>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              {disconnect("viva-disconnect")}
              <Form method="post">
                <input type="hidden" name="intent" value="viva-diagnostics" />
                <button type="submit" disabled={busy} className={QUIET_BUTTON}>
                  {t("payVivaDiagRun")}
                </button>
              </Form>
            </div>
          </Panel>
        )}

        {active === "iyzico" && iyzico && (
          <Panel
            name="iyzico"
            desc={t("payIyzicoDesc")}
            badge={<OkBadge>{iyzico.sandbox ? t("payIyzicoConnectedSandbox") : t("payConnected")}</OkBadge>}
          >
            <dl className={DETAIL_LIST}>
              <DetailRow label={t("payIyzicoMerchantId")}>
                <span className="font-mono text-[12px]">{iyzico.merchantId || "—"}</span>
              </DetailRow>
              <DetailRow label={t("payVivaEnvironment")}>
                {iyzico.sandbox ? t("payIyzicoEnvSandbox") : t("payVivaEnvLive")}
              </DetailRow>
            </dl>
            <p className="mt-3 text-[12px] leading-[1.5] text-muted-2">{t("payIyzicoNoGuarantee")}</p>
            <div className="mt-5">{disconnect("iyzico-disconnect")}</div>
          </Panel>
        )}

        {/* Said once, under the live gateway, instead of once per card that
            can't be used. */}
        {active && <p className="mt-3 text-[12px] leading-[1.5] text-muted-2">{t("payOneGateway")}</p>}

        {/* ---- Nothing connected: pick one, then set that one up ---- */}
        {!active && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              {PROVIDERS.map((p) => (
                <ProviderTile
                  key={p.id}
                  name={p.name}
                  desc={t(p.descKey)}
                  blocker={blockers[p.id]}
                  selected={choice === p.id}
                  onSelect={() => setChoice(p.id)}
                />
              ))}
            </div>

            {choice === "stripe" && (
              <div className="mt-4">
                <Panel name="Stripe" desc={t("payStripeDesc")}>
                  <Form method="post" className="mt-5 border-t border-divider pt-5">
                    <input type="hidden" name="intent" value="connect" />
                    <button type="submit" disabled={busy || !platformReady} className={PRIMARY_BUTTON}>
                      {t("payConnectWithStripe")}
                    </button>
                  </Form>
                </Panel>
              </div>
            )}

            {choice === "viva" && (
              <div className="mt-4">
                <Panel name="Viva" desc={t("payVivaDesc")}>
                  <Form method="post" className="mt-4 flex flex-col gap-3 border-t border-divider pt-4">
                    <input type="hidden" name="intent" value="viva-connect" />
                    <p className="text-[12px] leading-[1.5] text-muted">{t("payVivaSetupHelp")}</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <CredField name="merchantId" label={t("payVivaMerchantId")} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
                      <CredField name="apiKey" label={t("payVivaApiKey")} />
                      <CredField name="clientId" label={t("payVivaClientId")} placeholder="…apps.vivapayments.com" />
                      <CredField name="clientSecret" label={t("payVivaClientSecret")} />
                      <CredField name="sourceCode" label={t("payVivaSourceCode")} placeholder="1234" />
                    </div>
                    <label className="mt-1 flex items-center gap-2 text-[13px] text-secondary">
                      <input type="checkbox" name="isv" className="h-4 w-4 rounded border-line-alt text-accent focus:ring-accent" />
                      {t("payVivaIsvToggle")}
                    </label>
                    <p className="-mt-2 text-[12px] leading-[1.5] text-muted">{t("payVivaIsvHelp")}</p>
                    <label className="flex items-center gap-2 text-[13px] text-secondary">
                      <input type="checkbox" name="demo" className="h-4 w-4 rounded border-line-alt text-accent focus:ring-accent" />
                      {t("payVivaDemoToggle")}
                    </label>
                    <div className="mt-1">
                      <button type="submit" disabled={busy || !vivaCurrencyOk} className={PRIMARY_BUTTON}>
                        {busy ? t("payVivaVerifying") : t("payVivaConnect")}
                      </button>
                    </div>
                  </Form>
                </Panel>
              </div>
            )}

            {choice === "iyzico" && (
              <div className="mt-4">
                <Panel name="iyzico" desc={t("payIyzicoDesc")}>
                  <Form method="post" className="mt-4 flex flex-col gap-3 border-t border-divider pt-4">
                    <input type="hidden" name="intent" value="iyzico-connect" />
                    <p className="text-[12px] leading-[1.5] text-muted">{t("payIyzicoSetupHelp")}</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <CredField name="apiKey" label={t("payIyzicoApiKey")} placeholder="sandbox-…" />
                      <CredField name="secretKey" label={t("payIyzicoSecretKey")} />
                      <CredField name="merchantId" label={t("payIyzicoMerchantIdOptional")} />
                    </div>
                    <label className="mt-1 flex items-center gap-2 text-[13px] text-secondary">
                      <input type="checkbox" name="sandbox" className="h-4 w-4 rounded border-line-alt text-accent focus:ring-accent" />
                      {t("payIyzicoSandboxToggle")}
                    </label>
                    <div className="mt-1">
                      <button type="submit" disabled={busy || !iyzicoCurrencyOk} className={PRIMARY_BUTTON}>
                        {busy ? t("payIyzicoVerifying") : t("payIyzicoConnect")}
                      </button>
                    </div>
                  </Form>
                </Panel>
              </div>
            )}
          </>
        )}

        {/* Rendered for BOTH the connected panel's diagnostics button and a
            failed connect attempt — the ticket-worthy state is usually the
            failure, where no connected panel exists yet, so it sits at page
            level rather than inside Viva's card. Raw JSON on purpose: this
            block is pasted verbatim into a Viva support ticket, so it must not
            be translated or reformatted. No secrets (no access token). */}
        {actionData && "vivaDiag" in actionData && actionData.vivaDiag && (
          <div className="mt-4 rounded-[10px] border border-line bg-canvas p-3.5">
            <p className="mb-2 text-[12px] leading-[1.5] text-muted">{t("payVivaDiagHelp")}</p>
            <pre className="overflow-x-auto rounded-[8px] border border-line-alt bg-surface p-3 font-mono text-[11px] leading-[1.6] text-ink">
              {JSON.stringify(actionData.vivaDiag, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
