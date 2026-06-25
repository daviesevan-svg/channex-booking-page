// Outbound Open Channel calls (us → Channex). Currently the booking push;
// request_full_sync can join here later.
import { getConfig } from "./config.server";

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
    throw new Error(`Channex booking push failed (${res.status}): ${detail}`.slice(0, 400));
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
