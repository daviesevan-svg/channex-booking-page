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
  resendApiKey?: string;
  /** Open Channel inbound key: the one Channex sends to our /api endpoints. */
  openChannelApiKey: string;
  /** Open Channel outbound key: Channex-provided, used when WE call Channex's
   *  new_booking / full-sync webhooks. Falls back to the inbound key if unset. */
  openChannelBookingKey: string;
  /** Our provider code, used when calling Channex's full-sync/booking webhooks. */
  providerCode?: string;
  /** Channex Open Channel new_booking webhook (staging vs production host). */
  openChannelBookingUrl: string;
}

function read(key: string, fallback = ""): string {
  const value = (env as unknown as Record<string, string | undefined>)[key];
  return value ?? fallback;
}

export function getConfig(): AppConfig {
  return {
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
    sessionSecret: read("SESSION_SECRET") || "insecure-default-change-me-via-SESSION_SECRET",
    appUrl: read("APP_URL", "http://localhost:5173"),
    resendApiKey: read("RESEND_API_KEY") || undefined,
    openChannelApiKey: read("OPEN_CHANNEL_API_KEY"),
    openChannelBookingKey: read("OPEN_CHANNEL_BOOKING_KEY") || read("OPEN_CHANNEL_API_KEY"),
    providerCode: read("PROVIDER_CODE") || undefined,
    openChannelBookingUrl: read(
      "OPEN_CHANNEL_BOOKING_URL",
      "https://secure-staging.channex.io/api/v1/channel_webhooks/open_channel/new_booking",
    ),
  };
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
