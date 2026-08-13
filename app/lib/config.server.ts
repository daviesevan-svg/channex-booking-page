import { env } from "cloudflare:workers";

import { requestKvCache } from "./request-cache.server";

// Runtime configuration, read from Worker env bindings at request time.
// Set these in wrangler.jsonc (`vars`) for local/dev and in the Cloudflare
// dashboard for production. Changing them needs no rebuild.
export interface AppConfig {
  /** Channex API origin, e.g. https://app.channex.io */
  apiUrl: string;
  /** Booking Engine meta-channel code (REACT_APP_CHANNEL_CODE) */
  channelCode: string;
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
  /** Partner account key for the Google Vacation Rentals account, stamped on ARI
   *  messages from properties whose googleProgram is "vacation_rentals". Same
   *  transport/egress as hotels — only the partner account differs. Unset = VR
   *  push can't run (surfaced in the admin). */
  googleVrPartnerKey?: string;
  /** Shared secret sent as X-Ari-Proxy-Key when pushing via the egress proxy, so
   *  the proxy isn't an open relay to Google. Unset = header omitted (direct push). */
  googleAriProxyKey?: string;
  /** Travel Partner API (property match status). Service-account creds + numeric
   *  Hotel Center account id. All unset = the status check is skipped (fail-open). */
  googleTravelPartnerAccountId?: string;
  googleTravelPartnerSaEmail?: string;
  /** The service account's PEM private key (may contain literal \n from the JSON). */
  googleTravelPartnerSaKey?: string;
  /** Cloudflare for SaaS CNAME target — the hostname a hotel points their own
   *  domain at. Unset = the admin page says custom domains aren't available yet
   *  rather than printing a target that wouldn't work. */
  customHostnameTarget?: string;
  /** Cloudflare API token (SSL and Certificates: Edit) and the zone the custom
   *  hostnames live on. Both unset = a domain can be entered and DNS-checked but
   *  never activated, and the admin page says exactly that. Kept as dashboard
   *  SECRETS rather than pinned vars: a plaintext dashboard var not listed in
   *  wrangler `vars` is dropped on the next deploy, and silently losing these
   *  would strand every pending domain. */
  cloudflareApiToken?: string;
  cloudflareZoneId?: string;
  /** Extra hostnames that are ours, comma-separated — e.g. a marketing site or
   *  staging host on the same zone. Listed explicitly because the registrable
   *  domain can't be derived safely without a public suffix list. Used to refuse
   *  admin/API traffic arriving on a hotel's custom domain, and to stop a hotel
   *  claiming one of our own addresses. */
  ownHosts?: string;
  /** Scrapfly API key (secret — never in wrangler `vars`). Used only by the
   *  one-shot Booking.com onboarding import; unset = that wizard says the
   *  import isn't available and the owner adds the property manually. */
  scrapflyApiKey?: string;
}

function read(key: string, fallback = ""): string {
  const value = (env as unknown as Record<string, string | undefined>)[key];
  return value ?? fallback;
}

/** Strip whitespace and one wrapping pair of quotes from a pasted credential. */
function clean(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/s, "$2").trim();
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
    customHostnameTarget: read("CUSTOM_HOSTNAME_TARGET") || undefined,
    ownHosts: read("OWN_HOSTS") || undefined,
    // Trimmed and unquoted: these are pasted into `wrangler secret put`, which
    // takes the value literally, so a trailing newline or a wrapping pair of
    // quotes ends up inside the Bearer header and Cloudflare answers
    // "Authentication failed (status: 400)" — an hour of debugging a token that
    // was correct. Neither a token nor a zone id can legitimately contain either.
    cloudflareApiToken: clean(read("CLOUDFLARE_API_TOKEN")) || undefined,
    cloudflareZoneId: clean(read("CLOUDFLARE_ZONE_ID")) || undefined,
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
    googleVrPartnerKey: read("GOOGLE_VR_PARTNER_KEY") || undefined,
    googleAriProxyKey: read("GOOGLE_ARI_PROXY_KEY") || undefined,
    googleTravelPartnerAccountId: read("GOOGLE_TRAVELPARTNER_ACCOUNT_ID") || undefined,
    googleTravelPartnerSaEmail: read("GOOGLE_TRAVELPARTNER_SA_EMAIL") || undefined,
    googleTravelPartnerSaKey: read("GOOGLE_TRAVELPARTNER_SA_PRIVATE_KEY") || undefined,
    scrapflyApiKey: read("SCRAPFLY_API_KEY") || undefined,
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

/** The KV namespace holding per-property content overrides. Reads are deduped
 *  per request (see request-cache.server.ts): plain `get(key)` calls hit a
 *  request-scoped cache, and `put`/`delete` store the written value so a
 *  read-after-write within one request sees it (KV itself may serve the stale
 *  value for up to a minute). Gets with options (type/cacheTtl — none in this
 *  codebase today) bypass the cache rather than risk mixing shapes. */
export function getConfigKV(): KVNamespace {
  const kv = (env as unknown as { CONFIG_KV: KVNamespace }).CONFIG_KV;
  const cache = requestKvCache();
  if (!kv || !cache) return kv;
  return new Proxy(kv, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      const fn = v as (...a: unknown[]) => unknown;
      if (prop === "get") {
        return (key: unknown, ...rest: unknown[]) => {
          if (typeof key !== "string" || rest.length > 0) return fn.call(target, key, ...rest);
          const hit = cache.get(key);
          if (hit) return hit;
          const read = fn.call(target, key) as Promise<string | null>;
          cache.set(key, read);
          // A failed read must not be replayed to later callers as a cached
          // rejection — drop it so they retry against KV.
          read.catch(() => {
            if (cache.get(key) === read) cache.delete(key);
          });
          return read;
        };
      }
      if (prop === "put" || prop === "delete") {
        return (key: unknown, ...rest: unknown[]) => {
          if (typeof key !== "string") return fn.call(target, key, ...rest);
          const write = fn.call(target, key, ...rest) as Promise<unknown>;
          if (prop === "put" && typeof rest[0] !== "string") {
            // Can't mirror a stream/buffer value — just stop serving the old read.
            cache.delete(key);
            return write;
          }
          // Serve read-your-own-writes for the rest of the request: KV's edge
          // cache can return the stale value for up to a minute after a put, so
          // a re-read of a key this request just wrote must come from here, not
          // KV. (This made the OFF→ON Google push toggle silently no-op: the
          // re-push re-read the flag it had just written and saw the stale off.)
          const value = prop === "delete" ? null : (rest[0] as string);
          const entry = write.then(() => value) as Promise<string | null>;
          cache.set(key, entry);
          // A failed write must not masquerade as a successful read later.
          entry.catch(() => {
            if (cache.get(key) === entry) cache.delete(key);
          });
          return write;
        };
      }
      return fn.bind(target);
    },
  });
}

/** The R2 bucket holding uploaded images (undefined if not bound). */
export function getImagesBucket(): R2Bucket | undefined {
  return (env as unknown as { IMAGES?: R2Bucket }).IMAGES;
}

/** The D1 database holding pushed ARI (availability, rates, restrictions). */
export function getDB(): D1Database | undefined {
  return (env as unknown as { DB?: D1Database }).DB;
}
