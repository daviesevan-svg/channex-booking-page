import { env } from "cloudflare:workers";

import { createChannexClient, type ChannexConfig } from "./channex/client";

// Runtime configuration, read from Worker env bindings at request time.
// Set these in wrangler.jsonc (`vars`) for local/dev and in the Cloudflare
// dashboard for production. Changing them needs no rebuild.
export interface AppConfig extends ChannexConfig {
  pciUrl: string;
  googleMapKey?: string;
  /** When false, checkout simulates the booking instead of calling push_booking. */
  allowLiveBooking: boolean;
  /** Single-hotel deploys: route "/" straight to this property. */
  defaultPropertyId?: string;
  /** Admin */
  adminEmails: string[];
  /** Platform superadmins: see every property + manage users. Bootstraps the
   *  first superadmin; roles can also be granted from the Users page. */
  superadminEmails: string[];
  sessionSecret: string;
  appUrl: string;
  /** SparkPost API key for transactional email (Transmissions API). */
  sparkpostApiKey?: string;
  /** SparkPost API base, defaults to the US host. Set to
   *  https://api.eu.sparkpost.com for an EU account. */
  sparkpostApiUrl: string;
  /** Sender for transactional email, e.g. "Your Hotel <noreply@domain>".
   *  Must be on a SparkPost-verified sending domain; without it, email is skipped. */
  emailFrom?: string;
  /** Stripe platform secret key (sk_…). Charges run on each property's connected
   *  account via Stripe Connect; this is roompanda's platform account. */
  stripeSecretKey?: string;
  /** Stripe Connect client id (ca_…) for the Standard-account OAuth flow. */
  stripeConnectClientId?: string;
  /** Stripe webhook signing secret (whsec_…) for /api/stripe-webhook. */
  stripeWebhookSecret?: string;
  /** Optional platform fee in basis points taken from each charge (default 0). */
  stripePlatformFeeBps: number;
  /** Open Channel inbound key: the one Channex sends to our /api endpoints. */
  openChannelApiKey: string;
  /** Open Channel outbound key: Channex-provided, used when WE call Channex's
   *  new_booking / full-sync webhooks. Falls back to the inbound key if unset. */
  openChannelBookingKey: string;
  /** Our provider code, used when calling Channex's full-sync/booking webhooks. */
  providerCode?: string;
  /** Channex Open Channel new_booking webhook (staging vs production host). */
  openChannelBookingUrl: string;
  /** Google Hotels ARI push host. Default https://www.google.com. In production,
   *  point this at the static-egress-IP proxy (Google whitelists that one IP,
   *  since Workers have no stable egress IP). */
  googleAriBaseUrl: string;
  /** Partner account key from the Google Hotel Center account, stamped on every
   *  ARI message. Auth is IP-whitelist based; this only identifies the account.
   *  Unset = ARI push can't run (surfaced in the admin). */
  googleAriPartnerKey?: string;
  /** Shared secret sent as X-Ari-Proxy-Key when pushing via the egress proxy, so
   *  the proxy isn't an open relay to Google. Unset = header omitted (direct push). */
  googleAriProxyKey?: string;
  /** Travel Partner API (property match status). Service-account creds + numeric
   *  Hotel Center account id. All unset = the status check is skipped (fail-open). */
  googleTravelPartnerAccountId?: string;
  googleTravelPartnerSaEmail?: string;
  /** The service account's PEM private key (may contain literal \n from the JSON). */
  googleTravelPartnerSaKey?: string;
}

function read(key: string, fallback = ""): string {
  const value = (env as unknown as Record<string, string | undefined>)[key];
  return value ?? fallback;
}

// The placeholder used when SESSION_SECRET is unset. It's published in this
// public repo, so it must NEVER sign real sessions/tokens/API-key hashes — a
// production deploy that forgot the secret would be trivially forgeable. We fail
// closed in a prod build (below); dev keeps working with the placeholder.
const DEFAULT_SESSION_SECRET = "insecure-default-change-me-via-SESSION_SECRET";

export function getConfig(): AppConfig {
  const config: AppConfig = {
    apiUrl: read("CHANNEX_API_URL", "https://app.channex.io"),
    channelCode: read("CHANNEL_CODE"),
    groupId: read("GROUP_ID") || undefined,
    pciUrl: read("PCI_URL", "https://pci.vaultera.co"),
    googleMapKey: read("GOOGLE_MAP_KEY") || undefined,
    allowLiveBooking: read("ALLOW_LIVE_BOOKING") === "true",
    defaultPropertyId: read("DEFAULT_PROPERTY_ID") || undefined,
    adminEmails: read("ADMIN_EMAILS")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    superadminEmails: read("SUPERADMIN_EMAILS")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    // Never empty: an empty HMAC key throws in the Workers runtime.
    sessionSecret: read("SESSION_SECRET") || DEFAULT_SESSION_SECRET,
    appUrl: read("APP_URL", "http://localhost:5173"),
    stripeSecretKey: read("STRIPE_SECRET_KEY") || undefined,
    stripeConnectClientId: read("STRIPE_CONNECT_CLIENT_ID") || undefined,
    stripeWebhookSecret: read("STRIPE_WEBHOOK_SECRET") || undefined,
    stripePlatformFeeBps: Number(read("STRIPE_PLATFORM_FEE_BPS")) || 0,
    sparkpostApiKey: read("SPARKPOST_API_KEY") || undefined,
    sparkpostApiUrl: read("SPARKPOST_API_URL", "https://api.sparkpost.com").replace(/\/+$/, ""),
    emailFrom: read("EMAIL_FROM") || read("RESEND_FROM") || undefined,
    openChannelApiKey: read("OPEN_CHANNEL_API_KEY"),
    openChannelBookingKey: read("OPEN_CHANNEL_BOOKING_KEY") || read("OPEN_CHANNEL_API_KEY"),
    providerCode: read("PROVIDER_CODE") || undefined,
    openChannelBookingUrl: read(
      "OPEN_CHANNEL_BOOKING_URL",
      "https://secure-staging.channex.io/api/v1/channel_webhooks/open_channel/new_booking",
    ),
    googleAriBaseUrl: read("GOOGLE_ARI_BASE_URL", "https://www.google.com").replace(/\/+$/, ""),
    googleAriPartnerKey: read("GOOGLE_ARI_PARTNER_KEY") || undefined,
    googleAriProxyKey: read("GOOGLE_ARI_PROXY_KEY") || undefined,
    googleTravelPartnerAccountId: read("GOOGLE_TRAVELPARTNER_ACCOUNT_ID") || undefined,
    googleTravelPartnerSaEmail: read("GOOGLE_TRAVELPARTNER_SA_EMAIL") || undefined,
    googleTravelPartnerSaKey: read("GOOGLE_TRAVELPARTNER_SA_PRIVATE_KEY") || undefined,
  };
  // Fail closed: a production build must never sign with the public default
  // secret. (Dev builds keep the placeholder so local dev needs no setup.)
  if (import.meta.env.PROD && config.sessionSecret === DEFAULT_SESSION_SECRET) {
    throw new Error(
      "SESSION_SECRET is not set. Refusing to run in production with the public default secret — set SESSION_SECRET as a Cloudflare secret.",
    );
  }
  return config;
}

/** Convenience: a Channex client built from runtime config. */
export function getChannexClient() {
  return createChannexClient(getConfig());
}

/** The KV namespace holding per-property content overrides. */
export function getConfigKV(): KVNamespace {
  return (env as unknown as { CONFIG_KV: KVNamespace }).CONFIG_KV;
}

/** The R2 bucket holding uploaded images (undefined if not bound). */
export function getImagesBucket(): R2Bucket | undefined {
  return (env as unknown as { IMAGES?: R2Bucket }).IMAGES;
}

/** The D1 database holding pushed ARI (availability, rates, restrictions). */
export function getDB(): D1Database | undefined {
  return (env as unknown as { DB?: D1Database }).DB;
}
