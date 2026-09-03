// Outbound Open Channel calls (us → Channex): the booking push, booking
// revisions, and the full-sync request we use to recover from an ARI push we
// failed to store.
import { getConfig, getConfigKV } from "./config.server";

export interface OpenChannelBookingResult {
  id?: string;
  reservation_id?: string;
}

/** POST a booking to Channex's Open Channel new_booking webhook. Throws with the
 *  Channex error on a non-2xx response. */
export async function pushOpenChannelBooking(booking: unknown): Promise<OpenChannelBookingResult> {
  const { openChannelBookingKey, openChannelBookingUrl } = getConfig();
  const res = await fetch(openChannelBookingUrl, {
    method: "POST",
    headers: { "api-key": openChannelBookingKey, "Content-Type": "application/json" },
    body: JSON.stringify({ booking }),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail =
      body && typeof body === "object"
        ? JSON.stringify((body as { errors?: unknown }).errors ?? body)
        : String(body);
    throw new Error(`Channel manager booking push failed (${res.status}): ${detail}`.slice(0, 400));
  }
  // Channex replies { success: true, bookings: [{ id, unique_id }] }. Older/other
  // shapes (a bare object or { data }) are tolerated as a fallback.
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const first = Array.isArray(obj.bookings) ? (obj.bookings[0] as Record<string, unknown>) : undefined;
  if (first) {
    return { id: first.id as string | undefined, reservation_id: first.unique_id as string | undefined };
  }
  const data = (obj.data as OpenChannelBookingResult) ?? (obj as OpenChannelBookingResult);
  return data ?? {};
}

/** Push a revision of an existing booking to Channex (same new_booking webhook,
 *  the payload re-sent keyed by the original reservation_id with status
 *  "cancelled" or "modified"). Best effort — a revision must never fail the
 *  admin flow that triggered it, so this returns the outcome instead of
 *  throwing. */
export async function pushOpenChannelRevision(booking: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    await pushOpenChannelBooking(booking);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "revision push failed" };
  }
}

/** The request_full_sync webhook sits beside new_booking on the same channel
 *  path, so it is derived from the configured booking URL rather than being a
 *  second thing to set (and to get wrong) per environment. Returns null when
 *  the booking URL isn't the expected shape — better to report "not configured"
 *  than to POST a full-sync body at whatever endpoint that is. */
function fullSyncUrl(bookingUrl: string): string | null {
  const url = bookingUrl.replace(/\/+$/, "");
  return url.endsWith("/new_booking") ? `${url.slice(0, -"/new_booking".length)}/request_full_sync` : null;
}

/**
 * Ask Channex to re-send availability, rates and restrictions for a property in
 * full.
 *
 * This is the documented recovery from a lost changes_notification: Channex does
 * not re-send a change once it has been delivered, so a push we failed to store
 * is gone unless we ask for everything again. Best effort by design — the caller
 * is already handling a failure and must not be derailed by a second one.
 */
export async function requestFullSync(hotelCode: string): Promise<{ ok: boolean; error?: string }> {
  const { openChannelBookingKey, openChannelBookingUrl, providerCode } = getConfig();
  if (!hotelCode) return { ok: false, error: "no hotel code" };
  if (!providerCode) return { ok: false, error: "PROVIDER_CODE is not configured" };
  const url = fullSyncUrl(openChannelBookingUrl);
  if (!url) return { ok: false, error: `cannot derive request_full_sync from ${openChannelBookingUrl}` };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "api-key": openChannelBookingKey, "Content-Type": "application/json" },
      body: JSON.stringify({ provider_code: providerCode, hotel_code: hotelCode }),
    });
    if (!res.ok) return { ok: false, error: `full sync request failed (${res.status}): ${(await res.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "full sync request failed" };
  }
}

/** KV key marking a recently requested full sync, so repeated failures can't
 *  turn into a full-sync storm. */
const fullSyncKey = (hotelCode: string) => `ari:full-sync-requested:${hotelCode}`;

/** Request a full sync at most once per FULL_SYNC_COOLDOWN per property.
 *
 *  The rate limit matters when the cause is systematic rather than transient: a
 *  bug that throws on every ingest would otherwise ask for a full re-send on
 *  every push, and each re-send arrives as more pushes that also fail. Fails
 *  OPEN — if the KV read errors we still request the sync, because losing an
 *  availability update is worse than one redundant re-send. */
const FULL_SYNC_COOLDOWN_SECONDS = 600;

export async function requestFullSyncOnce(hotelCode: string): Promise<{ ok: boolean; error?: string; skipped?: true }> {
  if (!hotelCode) return { ok: false, error: "no hotel code" };
  const kv = getConfigKV();
  try {
    if (await kv.get(fullSyncKey(hotelCode))) return { ok: true, skipped: true };
  } catch {
    // fall through and request it
  }
  // Marked BEFORE the request, so a failure that takes the whole cooldown to
  // time out can't be retried in a tight loop by concurrent pushes.
  await kv.put(fullSyncKey(hotelCode), "1", { expirationTtl: FULL_SYNC_COOLDOWN_SECONDS }).catch(() => {});
  return await requestFullSync(hotelCode);
}
