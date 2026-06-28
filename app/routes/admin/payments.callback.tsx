import { redirect } from "react-router";

import type { Route } from "./+types/payments.callback";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { savePaymentSettings } from "~/lib/overrides.server";
import { oauthToken, retrieveAccount } from "~/lib/stripe.server";

// Stripe redirects here after the operator authorises the Connect OAuth flow.
export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const url = new URL(request.url);
  const propertyId = await currentPropertyId(request);

  if (url.searchParams.get("error")) {
    return redirect("/admin/payments?stripe=denied");
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  // `state` is the property the connect flow started for — it must match the
  // admin's currently-selected property (both come from their session/flow).
  if (!code || !propertyId || state !== propertyId) {
    return redirect("/admin/payments?stripe=error");
  }

  try {
    const { stripe_user_id } = await oauthToken(code);
    const account = await retrieveAccount(stripe_user_id).catch(() => null);
    await savePaymentSettings(propertyId, {
      stripeAccountId: stripe_user_id,
      stripeChargesEnabled: account?.charges_enabled ?? false,
    });
  } catch {
    return redirect("/admin/payments?stripe=error");
  }
  return redirect("/admin/payments");
}
