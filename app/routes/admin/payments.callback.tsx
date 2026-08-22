import { redirect } from "react-router";

import type { Route } from "./+types/payments.callback";
import { consumeStripeConnectState, requireAdmin } from "~/lib/auth.server";
import { canAccess } from "~/lib/properties.server";
import { savePaymentSettings } from "~/lib/overrides.server";
import { oauthToken, retrieveAccount } from "~/lib/stripe.server";

function paymentsRedirect(notice: string, cookie?: string) {
  return redirect(`/admin/payments?stripe=${notice}`, cookie ? { headers: { "Set-Cookie": cookie } } : undefined);
}

// Stripe redirects here after the operator authorises the Connect OAuth flow.
export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const url = new URL(request.url);
  const state = url.searchParams.get("state");

  if (url.searchParams.get("error")) {
    // Burn a matching nonce so a denied round-trip can't be replayed.
    const consumed = await consumeStripeConnectState(request, state);
    return paymentsRedirect("denied", consumed?.cookie);
  }
  const code = url.searchParams.get("code");
  if (!code) return paymentsRedirect("error");

  // `state` must be the session nonce stamped when this admin clicked Connect.
  // Attach to that stored propertyId — never a client-supplied UUID.
  const consumed = await consumeStripeConnectState(request, state);
  if (!consumed) {
    console.log("[stripe] oauth state rejected: missing, unknown, or already used");
    return paymentsRedirect("mismatch");
  }
  const { propertyId, cookie } = consumed;
  if (!(await canAccess(request, propertyId))) {
    console.log(`[stripe] oauth state property not accessible: ${propertyId}`);
    return paymentsRedirect("mismatch", cookie);
  }

  try {
    const { stripe_user_id } = await oauthToken(code);
    const account = await retrieveAccount(stripe_user_id).catch(() => null);
    await savePaymentSettings(propertyId, {
      stripeAccountId: stripe_user_id,
      stripeChargesEnabled: account?.charges_enabled ?? false,
    });
  } catch (e) {
    console.log(`[stripe] oauth callback failed: ${e instanceof Error ? e.message : e}`);
    return paymentsRedirect("error", cookie);
  }
  return paymentsRedirect("connected", cookie);
}
