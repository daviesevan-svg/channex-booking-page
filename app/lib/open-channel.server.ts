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
  const { openChannelApiKey, openChannelBookingUrl } = getConfig();
  const res = await fetch(openChannelBookingUrl, {
    method: "POST",
    headers: { "api-key": openChannelApiKey, "Content-Type": "application/json" },
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
  const data = (body as { data?: OpenChannelBookingResult })?.data ?? (body as OpenChannelBookingResult);
  return data ?? {};
}
