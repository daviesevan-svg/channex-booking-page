import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/payments";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getConfig } from "~/lib/config.server";
import { getSettings, savePaymentSettings } from "~/lib/overrides.server";
import { deauthorize, oauthAuthorizeUrl, retrieveAccount } from "~/lib/stripe.server";
import { redirect } from "react-router";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const settings = await getSettings(propertyId);
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
  return {
    configured: true as const,
    platformReady: Boolean(getConfig().stripeConnectClientId),
    secretReady: Boolean(getConfig().stripeSecretKey),
    accountId: settings.stripeAccountId,
    chargesEnabled: account?.chargesEnabled ?? settings.stripeChargesEnabled ?? false,
    account,
    notice: new URL(request.url).searchParams.get("stripe") || undefined,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "Add a property first." };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "disconnect") {
    const settings = await getSettings(propertyId);
    if (settings.stripeAccountId) await deauthorize(settings.stripeAccountId).catch(() => {});
    await savePaymentSettings(propertyId, {});
    return { ok: true };
  }

  if (intent === "connect") {
    if (!getConfig().stripeConnectClientId) return { error: "Stripe is not configured on the platform yet." };
    // State ties the OAuth round-trip to the admin's currently-selected property
    // (it comes from their own session), so a callback can't target another one.
    const redirectUri = `${new URL(request.url).origin}/admin/payments/callback`;
    throw redirect(oauthAuthorizeUrl(propertyId, redirectUri));
  }
  return { error: "Unknown action." };
}

export function meta() {
  return [{ title: "Admin · Payments" }];
}

export default function AdminPayments({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Payments</h1>
        <p className="text-[15px] text-secondary">Add a property first to connect payments.</p>
      </div>
    );
  }

  const { platformReady, secretReady, accountId, chargesEnabled, account, notice } = loaderData;
  const connected = Boolean(accountId);

  const NOTICES: Record<string, { ok: boolean; text: string }> = {
    connected: { ok: true, text: "Stripe connected." },
    denied: { ok: false, text: "Stripe connection was cancelled." },
    mismatch: {
      ok: false,
      text: "Couldn't match this to the selected property — make sure the right property is selected, then try again.",
    },
    error: {
      ok: false,
      text: "Couldn't complete the Stripe connection. Check that the Stripe secret key is set on the server, then try again (details in the server logs).",
    },
  };
  const banner = notice ? NOTICES[notice] : undefined;

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">Payments</h1>
        {actionData?.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">✓ Saved</span>
        )}
      </div>

      <p className="mb-5 max-w-2xl text-[14px] text-secondary">
        Connect this property's Stripe account to take deposits and prepayments at checkout. Payments
        go directly to your Stripe account — guests pay on Stripe's secure hosted page.
      </p>

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
        <p className="mb-4 max-w-2xl rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-2.5 text-[12.5px] text-amber-800">
          The Stripe secret key isn't set on this environment, so connecting can't complete. Set
          <code className="mx-1 rounded bg-white/60 px-1">STRIPE_SECRET_KEY</code>in the Worker's
          variables, then try again.
        </p>
      )}

      {actionData?.error && (
        <p className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-700">
          {actionData.error}
        </p>
      )}

      <div className="max-w-xl rounded-[14px] border border-line bg-surface p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-serif text-[18px] font-semibold">Stripe</div>
            <div className="text-[12.5px] text-muted">Card payments &amp; more, via Stripe Checkout</div>
          </div>
          {connected && (
            <span
              className={`flex-none rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${
                chargesEnabled ? "bg-[#e8f0e6] text-[#3f7a52]" : "bg-[#fbeede] text-[#9a6a1e]"
              }`}
            >
              {chargesEnabled ? "Connected" : "Connected · finish setup"}
            </span>
          )}
        </div>

        {connected && (
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 border-t border-divider pt-4 text-[13px]">
            {account?.name && (
              <>
                <dt className="text-muted">Account</dt>
                <dd className="font-semibold text-ink">{account.name}</dd>
              </>
            )}
            <dt className="text-muted">Account ID</dt>
            <dd className="font-mono text-[12px] text-ink">{accountId}</dd>
            {account?.email && (
              <>
                <dt className="text-muted">Email</dt>
                <dd className="text-ink">{account.email}</dd>
              </>
            )}
            {(account?.country || account?.currency) && (
              <>
                <dt className="text-muted">Country / currency</dt>
                <dd className="text-ink">{[account?.country, account?.currency].filter(Boolean).join(" · ")}</dd>
              </>
            )}
            <dt className="text-muted">Charges</dt>
            <dd className={chargesEnabled ? "font-semibold text-[#3f7a52]" : "font-semibold text-[#9a6a1e]"}>
              {chargesEnabled ? "Enabled" : "Not enabled yet"}
            </dd>
          </dl>
        )}

        {connected && !chargesEnabled && (
          <p className="mt-3 text-[13px] text-secondary">
            This Stripe account isn't able to accept charges yet — finish onboarding in your Stripe
            dashboard, then reconnect to refresh the status.
          </p>
        )}

        {!platformReady && (
          <p className="mt-3 rounded-[10px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-800">
            Stripe Connect isn't configured on the platform yet (missing STRIPE_CONNECT_CLIENT_ID).
          </p>
        )}

        <div className="mt-5">
          {connected ? (
            <Form method="post">
              <input type="hidden" name="intent" value="disconnect" />
              <button
                type="submit"
                disabled={busy}
                className="rounded-[10px] border border-line-alt bg-surface px-4 py-2.5 text-[14px] font-semibold text-secondary hover:border-accent hover:text-accent disabled:opacity-60"
              >
                Disconnect
              </button>
            </Form>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="connect" />
              <button
                type="submit"
                disabled={busy || !platformReady}
                className="rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
              >
                Connect with Stripe
              </button>
            </Form>
          )}
        </div>
      </div>
    </div>
  );
}
