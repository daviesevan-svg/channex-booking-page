// Clone a property: copy its content stores under a new property id so a host
// with several near-identical units (e.g. 4 apartments in one building) can
// clone once per unit and just delete the rooms that don't apply — the fast
// path to the "one single-unit property per Google VR listing" model.
import { getConfigKV } from "./config.server";
import { addProperty, getProperty } from "./properties.server";
import type { SiteSettings } from "./content";

/** Content-like stores that make sense on a copy. Room/rate ids are kept as-is
 *  (KV keys are per-property, so ids can't collide across properties, and the
 *  copied rooms keep referencing the original R2 image keys — which serve by
 *  key, not by property). */
const COPY_KEYS = [
  "settings",
  "overrides",
  "content",
  "email_content",
  "catalog_rooms",
  "catalog_rates",
  "extras",
  "extras_seeded", // so the clone doesn't re-seed demo extras on top of the copies
  "promotions",
] as const;

// Deliberately NOT copied: api_keys, webhooks, bookings, google_ari_sync — and
// the registry entry's slug/public flag. Those are identity/operational, not
// content.

/** Create a clone of `sourceId` owned by `owner`. Returns the new property id. */
export async function cloneProperty(sourceId: string, owner?: string): Promise<string> {
  const source = await getProperty(sourceId);
  if (!source) throw new Error("Property not found.");
  const kv = getConfigKV();
  if (!kv) throw new Error("No KV configured.");

  const id = crypto.randomUUID();
  for (const prefix of COPY_KEYS) {
    const raw = await kv.get(`${prefix}:${sourceId}`);
    if (raw == null) continue;
    if (prefix === "settings") {
      // Sanitize connection/identity state: the clone is a NEW property. It is
      // not connected to Channex (the connectivity gate keeps its traffic
      // simulated until the host connects it), doesn't push to Google, and
      // starts in test booking mode. The Stripe connection IS kept — same
      // owner, same account. Everything else (taxes, policies, theme,
      // languages, amenities…) carries over.
      const settings = JSON.parse(raw) as SiteSettings & { connectedSystem?: string };
      delete settings.connectedSystem;
      delete settings.liveBooking;
      settings.googleAriPush = false;
      await kv.put(`${prefix}:${id}`, JSON.stringify(settings));
    } else {
      await kv.put(`${prefix}:${id}`, raw);
    }
  }

  // Registry entry: fresh id, "(copy)" name, same owner, NOT public, no slug.
  await addProperty(id, `${source.name} (copy)`, owner ?? source.owner);
  return id;
}
