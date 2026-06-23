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
  sessionSecret: string;
  appUrl: string;
  resendApiKey?: string;
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
    sessionSecret: read("SESSION_SECRET", "dev-insecure-secret-change-me"),
    appUrl: read("APP_URL", "http://localhost:5173"),
    resendApiKey: read("RESEND_API_KEY") || undefined,
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
