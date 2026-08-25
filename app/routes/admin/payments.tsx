import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/payments";
import { adminMeta } from "~/lib/admin-meta";
import { SavedPill } from "~/components/admin-page-header";
import { requireAdmin, stampStripeConnectState } from "~/lib/auth.server";
import { currentPropertyId, isOwnerOrSuper } from "~/lib/properties.server";
import { getConfig } from "~/lib/config.server";
import { getSettings, getVivaConfig, savePaymentSettings, saveVivaConfig } from "~/lib/overrides.server";
import { getProperty } from "~/lib/properties.server";
import { guestHostForProperty } from "~/lib/partners.server";
import { deauthorize, oauthAuthorizeUrl, retrieveAccount } from "~/lib/stripe.server";
import { runVivaDiagnostics, verifyVivaConfig, VIVA_CURRENCIES } from "~/lib/viva.server";
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
    canOwn: await isOwnerOrSuper(request, propertyId),
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "Add a property first." };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (
    intent === "connect" ||
    intent === "disconnect" ||
    intent === "viva-connect" ||
    intent === "viva-disconnect" ||
    intent === "viva-diagnostics"
  ) {
    if (!(await isOwnerOrSuper(request, propertyId))) {
      return { error: "Only an owner or manager can connect or disconnect payments." };
    }
  }

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
  return { error: "Unknown action." };
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "navPayments" });
}

function VivaField({ name, label, placeholder }: { name: string; label: string; placeholder?: string }) {
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

  const { propertyName, platformReady, secretReady, accountId, chargesEnabled, account, notice, viva, vivaUrls, currency, vivaCurrencyOk, canOwn } = loaderData;
  const connected = Boolean(accountId);
  const vivaConnected = Boolean(viva);

  const NOTICES: Record<string, { ok: boolean; text: string }> = {
    connected: { ok: true, text: t("payNoticeConnected") },
    denied: { ok: false, text: t("payNoticeDenied") },
    mismatch: { ok: false, text: t("payNoticeMismatch") },
    error: { ok: false, text: t("payNoticeError") },
  };
  const banner = notice ? NOTICES[notice] : undefined;

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

      <p className="mb-5 max-w-2xl text-[14px] text-secondary">{t("payIntro")}</p>

      {banner && (
        <p
          className={`mb-4 max-w-2xl rounded-[10px] border px-4 py-2.5 text-[13px] ${
            banner.ok ? "border-[#cfe3d0] bg-[#eef5ec] text-[#3f7a52]" : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {banner.ok ? "✓ " : ""}
          {banner.text}
        </p>
      )}

      {platformReady && !secretReady && (
        <p className="mb-4 max-w-2xl rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-800">
          {t("paySecretMissingBefore")}
          <code className="mx-1 rounded bg-white/60 px-1">STRIPE_SECRET_KEY</code>
          {t("paySecretMissingAfter")}
        </p>
      )}

      {actionData?.error && (
        <p className="mb-4 max-w-xl rounded-[10px] border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-700">
          {actionData.error}
        </p>
      )}

      <div className="flex max-w-5xl flex-wrap items-start gap-5">
        {/* ---- Stripe ---- */}
        <div className="min-w-[320px] max-w-xl flex-1 rounded-[14px] border border-line bg-surface p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-serif text-[18px] font-semibold">Stripe</div>
              <div className="text-[12px] text-muted">{t("payStripeDesc")}</div>
            </div>
            {connected && (
              <span
                className={`flex-none rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                  chargesEnabled ? "bg-[#e8f0e6] text-[#3f7a52]" : "bg-[#fbeede] text-[#9a6a1e]"
                }`}
              >
                {chargesEnabled ? t("payConnected") : t("payConnectedFinishSetup")}
              </span>
            )}
          </div>

          {connected && (
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 border-t border-divider pt-4 text-[13px]">
              {account?.name && (
                <>
                  <dt className="text-muted">{t("payAccount")}</dt>
                  <dd className="font-semibold text-ink">{account.name}</dd>
                </>
              )}
              <dt className="text-muted">{t("payAccountId")}</dt>
              <dd className="font-mono text-[12px] text-ink">{accountId}</dd>
              {account?.email && (
                <>
                  <dt className="text-muted">{t("payEmail")}</dt>
                  <dd className="text-ink">{account.email}</dd>
                </>
              )}
              {(account?.country || account?.currency) && (
                <>
                  <dt className="text-muted">{t("payCountryCurrency")}</dt>
                  <dd className="text-ink">{[account?.country, account?.currency].filter(Boolean).join(" · ")}</dd>
                </>
              )}
              <dt className="text-muted">{t("payCharges")}</dt>
              <dd className={chargesEnabled ? "font-semibold text-[#3f7a52]" : "font-semibold text-[#9a6a1e]"}>
                {chargesEnabled ? t("payEnabled") : t("payNotEnabledYet")}
              </dd>
            </dl>
          )}

          {connected && !chargesEnabled && (
            <p className="mt-3 text-[13px] text-secondary">{t("payFinishOnboarding")}</p>
          )}

          {!platformReady && (
            <p className="mt-3 rounded-[10px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12px] text-amber-800">
              {t("payPlatformMissing")}
            </p>
          )}

          {canOwn && (
          <div className="mt-5">
            {connected ? (
              <Form method="post">
                <input type="hidden" name="intent" value="disconnect" />
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-[10px] border border-line-alt bg-surface px-4 py-2.5 text-[14px] font-semibold text-secondary hover:border-accent hover:text-accent disabled:opacity-60"
                >
                  {t("payDisconnect")}
                </button>
              </Form>
            ) : (
              <Form method="post">
                <input type="hidden" name="intent" value="connect" />
                <button
                  type="submit"
                  disabled={busy || !platformReady || vivaConnected}
                  className="rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
                >
                  {t("payConnectWithStripe")}
                </button>
                {vivaConnected && <p className="mt-2 text-[12px] text-muted-2">{t("payOneGateway")}</p>}
              </Form>
            )}
          </div>
          )}
        </div>

        {/* ---- Viva ---- */}
        <div className="min-w-[320px] max-w-xl flex-1 rounded-[14px] border border-line bg-surface p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-serif text-[18px] font-semibold">Viva</div>
              <div className="text-[12px] text-muted">{t("payVivaDesc")}</div>
            </div>
            {vivaConnected && (
              <span className="flex-none rounded-full bg-[#e8f0e6] px-2.5 py-1 text-[11px] font-semibold text-[#3f7a52]">
                {viva?.demo ? t("payVivaConnectedDemo") : t("payConnected")}
              </span>
            )}
          </div>

          {!vivaCurrencyOk && (
            <p className="mt-3 rounded-[10px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12px] text-amber-800">
              {t("payVivaCurrency", { currency })}
            </p>
          )}

          {vivaConnected && viva ? (
            <>
              <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 border-t border-divider pt-4 text-[13px]">
                <dt className="text-muted">{t("payVivaMerchantId")}</dt>
                <dd className="font-mono text-[12px] text-ink">{viva.merchantId}</dd>
                <dt className="text-muted">{t("payVivaSourceCode")}</dt>
                <dd className="font-mono text-[12px] text-ink">{viva.sourceCode}</dd>
                <dt className="text-muted">{t("payVivaEnvironment")}</dt>
                <dd className="text-ink">{viva.demo ? t("payVivaEnvDemo") : t("payVivaEnvLive")}</dd>
                <dt className="text-muted">{t("payVivaModel")}</dt>
                <dd className="text-ink">{viva.isv ? t("payVivaModelIsv") : t("payVivaModelMerchant")}</dd>
              </dl>

              <div className="mt-4 rounded-[10px] border border-line bg-canvas p-3.5">
                <p className="mb-2 text-[12px] font-semibold text-secondary">{t("payVivaUrlsTitle")}</p>
                <p className="mb-3 text-[12px] leading-[1.5] text-muted">{t("payVivaUrlsHelp")}</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
                  <UrlRow label={t("payVivaSuccessUrl")} value={vivaUrls.success} />
                  <UrlRow label={t("payVivaFailureUrl")} value={vivaUrls.failure} />
                  <UrlRow label={t("payVivaWebhookUrl")} value={vivaUrls.webhook} />
                </dl>
              </div>

              <p className="mt-3 text-[12px] leading-[1.5] text-muted-2">{t("payVivaNoGuarantee")}</p>

              {canOwn && (
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <Form method="post">
                  <input type="hidden" name="intent" value="viva-disconnect" />
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-[10px] border border-line-alt bg-surface px-4 py-2.5 text-[14px] font-semibold text-secondary hover:border-accent hover:text-accent disabled:opacity-60"
                  >
                    {t("payDisconnect")}
                  </button>
                </Form>
                <Form method="post">
                  <input type="hidden" name="intent" value="viva-diagnostics" />
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-[10px] border border-line-alt bg-surface px-4 py-2.5 text-[14px] font-semibold text-secondary hover:border-accent hover:text-accent disabled:opacity-60"
                  >
                    {t("payVivaDiagRun")}
                  </button>
                </Form>
              </div>
              )}

            </>
          ) : canOwn ? (
            <Form method="post" className="mt-4 flex flex-col gap-3 border-t border-divider pt-4">
              <input type="hidden" name="intent" value="viva-connect" />
              <p className="text-[12px] leading-[1.5] text-muted">{t("payVivaSetupHelp")}</p>
              <VivaField name="merchantId" label={t("payVivaMerchantId")} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
              <VivaField name="apiKey" label={t("payVivaApiKey")} />
              <VivaField name="clientId" label={t("payVivaClientId")} placeholder="…apps.vivapayments.com" />
              <VivaField name="clientSecret" label={t("payVivaClientSecret")} />
              <VivaField name="sourceCode" label={t("payVivaSourceCode")} placeholder="1234" />
              <label className="flex items-center gap-2 text-[13px] text-secondary">
                <input type="checkbox" name="isv" className="h-4 w-4 rounded border-line-alt text-accent focus:ring-accent" />
                {t("payVivaIsvToggle")}
              </label>
              <p className="-mt-2 text-[12px] leading-[1.5] text-muted">{t("payVivaIsvHelp")}</p>
              <label className="flex items-center gap-2 text-[13px] text-secondary">
                <input type="checkbox" name="demo" className="h-4 w-4 rounded border-line-alt text-accent focus:ring-accent" />
                {t("payVivaDemoToggle")}
              </label>
              <div>
                <button
                  type="submit"
                  disabled={busy || connected || !vivaCurrencyOk}
                  className="rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
                >
                  {busy ? t("payVivaVerifying") : t("payVivaConnect")}
                </button>
                {connected && <p className="mt-2 text-[12px] text-muted-2">{t("payOneGateway")}</p>}
              </div>
            </Form>
          ) : null}

          {/* Rendered for BOTH the connected card's diagnostics button and a
              failed connect attempt — the ticket-worthy state is usually the
              failure, where no connected card exists yet. Raw JSON on purpose:
              this block is pasted verbatim into a Viva support ticket, so it
              must not be translated or reformatted. No secrets (no access token). */}
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
    </div>
  );
}
