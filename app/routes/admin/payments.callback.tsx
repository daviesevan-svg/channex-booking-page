import { redirect } from "react-router";

import type { Route } from "./+types/payments.callback";
import { consumeStripeConnectState, requireAdmin } from "~/lib/auth.server";
import { canAccess, hiddenMemberAreasFor } from "~/lib/properties.server";
import { getConfig } from "~/lib/config.server";
import { isLocalHost, isNamedOwnHost } from "~/lib/domains.server";
import { savePaymentSettings } from "~/lib/overrides.server";
import { partnerIdForAdminHost } from "~/lib/partners.server";
import { decodeConnectState } from "~/lib/stripe-connect-state";
import { oauthToken, retrieveAccount } from "~/lib/stripe.server";

function paymentsRedirect(notice: string, cookie?: string) {
  return redirect(`/admin/payments?stripe=${notice}`, cookie ? { headers: { "Set-Cookie": cookie } } : undefined);
}

/**
 * Whether Stripe's answer may be handed on to `returnOrigin`. The origin comes
 * out of `state`, which is whatever the link the admin clicked carried — so it
 * is checked as a stranger's value: a registered partner admin host, or a host
 * that is ours by name. Never a pattern such as `*.workers.dev` (anyone can
 * register one, and the authorisation code would be delivered to it). https
 * only; plain http and localhost are for a developer whose APP_URL is itself
 * local.
 */
async function servesOurAdmin(returnOrigin: string): Promise<boolean> {
  const target = new URL(returnOrigin);
  const host = target.hostname;
  if (isLocalHost(host)) {
    try {
      return isLocalHost(new URL(getConfig().appUrl).hostname);
    } catch {
      return false;
    }
  }
  if (target.protocol !== "https:") return false;
  return isNamedOwnHost(host) || Boolean(await partnerIdForAdminHost(host));
}

// Stripe redirects here after the operator authorises the Connect OAuth flow.
//
// Declared OUTSIDE the admin layout in routes.ts: the layout's loader requires
// a session, and the partner-host hop below arrives without one on this host.
// Everything past the hop still runs requireAdmin itself.
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const decoded = decodeConnectState(url.searchParams.get("state"));

  // Partner-host round trip (see payments.tsx `connect`). Stripe could only
  // send the admin back to the canonical host, but their session — and the
  // one-time nonce in it — live on the partner's admin host. Hand Stripe's
  // answer on, untouched, and let THAT host's callback do every check. Not an
  // open redirect: the target must be a host that serves an admin of ours (our
  // own by name, or a registered partner admin host — see servesOurAdmin). The
  // forwarded state is the bare nonce, so the hop happens once and the
  // receiving side is unchanged.
  if (decoded?.returnOrigin && decoded.returnOrigin !== url.origin) {
    if (await servesOurAdmin(decoded.returnOrigin)) {
      const onward = new URL("/admin/payments/callback", decoded.returnOrigin);
      for (const key of ["code", "error", "error_description"]) {
        const value = url.searchParams.get(key);
        if (value) onward.searchParams.set(key, value);
      }
      onward.searchParams.set("state", decoded.nonce);
      return redirect(onward.toString());
    }
    console.log(`[stripe] oauth return origin is not an admin host of ours: ${decoded.returnOrigin}`);
  }

  await requireAdmin(request);
  const state = decoded?.nonce ?? null;

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
  // Payments is editable by anyone who can open the page (owner, superadmin,
  // partner admin, or a teammate the owner left the `payments` area open to).
  // The nonce could only have been minted behind that same guard, but re-check
  // the area here: this loader resolves the property from the stored nonce, so
  // assertMemberAreaAllowed on currentPropertyId never runs for it, and an
  // owner who revokes the area mid-flow must not have a leftover nonce land.
  if ((await hiddenMemberAreasFor(request, propertyId)).includes("payments")) {
    console.log(`[stripe] oauth state property payments area hidden: ${propertyId}`);
    return paymentsRedirect("denied", cookie);
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
