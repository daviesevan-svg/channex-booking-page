// The new-property setup checklist: what still stands between this property
// and a real, paid, guest-visible booking.
//
// Every step is DERIVED from the stored data at render time — there is no
// stored todo state to drift out of sync, no "mark as done" to lie with. The
// list names the exact gates the booking engine actually enforces: a night
// with no inventory row counts as 0 (ari/read.server), a room with no priced rate
// never renders, checkout without a Stripe account can only simulate, and a
// property with liveBooking off tells guests it's in test mode.
import { format, addDays } from "date-fns";

import { getLastAriReceivedAt } from "./ari/ingest.server";
import { getInventory } from "./ari/read.server";
import { getRates, getRooms } from "./catalog.server";
import { getGalleryFor } from "./gallery.server";
import { getHeroImage, getOverrides, getSettings, getVivaConfig } from "./overrides.server";
import { getProperty } from "./properties.server";

export interface SetupStep {
  key: "basics" | "rooms" | "prices" | "availability" | "payments" | "website" | "golive";
  done: boolean;
  /** Admin page that completes the step. */
  to: string;
}

/** A data-entry hole that doesn't BLOCK bookings but that guests (or the
 *  owner's accountant) will notice: a room nobody priced, missing photos,
 *  no contact details. Room-scoped gaps carry a count. */
export interface SetupGap {
  key:
    | "rooms_photos"
    | "rooms_desc"
    | "rooms_unpriced"
    | "rooms_closed"
    | "contact"
    | "description"
    | "times"
    | "location"
    | "legal"
    | "taxes";
  count?: number;
  /** Admin page where the gap is fixed. */
  to: string;
}

export interface SetupChecklist {
  steps: SetupStep[];
  doneCount: number;
  complete: boolean;
  gaps: SetupGap[];
}

export async function setupChecklist(pid: string): Promise<SetupChecklist> {
  const [settings, overrides, property, rooms, rates, hero, gallery, viva] = await Promise.all([
    getSettings(pid),
    getOverrides(pid),
    getProperty(pid),
    getRooms(pid),
    getRates(pid),
    getHeroImage(pid),
    getGalleryFor(pid),
    getVivaConfig(pid),
  ]);
  const channex = settings.connectedSystem === "channex";

  // Prices: a Channex property gets live nightly rates via ARI, so having rate
  // plans at all is the gate; a native property sells nothing until some
  // active rate carries a real base price.
  const priced = channex
    ? rates.length > 0
    : rates.some((r) => r.active && Object.values(r.prices).some((p) => p > 0));

  // Availability: Channex properties receive it by ARI push; native ones must
  // set inventory by hand, and a night with no row is NOT bookable — so look
  // for any open night in the next 30 days. The per-room view feeds the gap
  // audit below: "the property has availability" and "every room does" differ
  // exactly where a room was forgotten.
  let hasAvailability = false;
  const openRooms = new Set<string>();
  if (channex) {
    hasAvailability = (await getLastAriReceivedAt(pid)) != null;
  } else if (rooms.length > 0) {
    const from = format(new Date(), "yyyy-MM-dd");
    const to = format(addDays(new Date(), 30), "yyyy-MM-dd");
    const inv = await getInventory(pid, from, to);
    for (const [key, n] of Object.entries(inv.availability)) {
      if (n > 0) openRooms.add(key.split("|")[0]);
    }
    hasAvailability = openRooms.size > 0;
  }

  const steps: SetupStep[] = [
    {
      key: "basics",
      done: Boolean(overrides.hotelName && overrides.address && (hero || gallery.length > 0)),
      to: "/admin",
    },
    { key: "rooms", done: rooms.length > 0, to: "/admin/rooms" },
    { key: "prices", done: priced, to: "/admin/rates" },
    { key: "availability", done: hasAvailability, to: channex ? "/admin/connectivity" : "/admin/inventory" },
    { key: "payments", done: Boolean(settings.stripeAccountId || viva), to: "/admin/payments" },
    { key: "website", done: Boolean(property?.slug), to: "/admin/general" },
    { key: "golive", done: settings.liveBooking === true, to: "/admin/general" },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  // ---- data-entry gaps ----
  // These never block the go-live gates above; they name the holes a hurried
  // setup leaves behind. Room-scoped checks only make sense once rooms exist,
  // and the availability one only once the property has ANY open nights —
  // before that the gate itself is the message.
  const gaps: SetupGap[] = [];
  const pushRoomGap = (key: SetupGap["key"], to: string, count: number) => {
    if (count > 0) gaps.push({ key, to, count });
  };

  if (rooms.length > 0) {
    pushRoomGap("rooms_photos", "/admin/rooms", rooms.filter((r) => r.images.length === 0).length);
    pushRoomGap("rooms_desc", "/admin/rooms", rooms.filter((r) => !r.description?.trim()).length);
    // A room no rate plan prices never renders to guests — the most invisible
    // miss there is. Channex rates carry ARI-fed prices, so there presence in
    // the rate's per-room price map is the test; native needs a real amount.
    const roomPriced = (roomId: string) =>
      rates.some((r) => {
        if (!r.active) return false;
        const p = r.prices[roomId];
        return channex ? p !== undefined : typeof p === "number" && p > 0;
      });
    pushRoomGap("rooms_unpriced", "/admin/rates", rooms.filter((r) => !roomPriced(r.id)).length);
    if (!channex && hasAvailability) {
      pushRoomGap("rooms_closed", "/admin/inventory", rooms.filter((r) => !openRooms.has(r.id)).length);
    }
  }
  if (!overrides.email?.trim() && !overrides.phone?.trim()) gaps.push({ key: "contact", to: "/admin" });
  if (!overrides.description?.trim()) gaps.push({ key: "description", to: "/admin" });
  if (!settings.checkinTime || !settings.checkoutTime) gaps.push({ key: "times", to: "/admin" });
  if (!settings.latitude || !settings.longitude) gaps.push({ key: "location", to: "/admin" });
  if (!settings.termsUrl && !settings.privacyUrl) gaps.push({ key: "legal", to: "/admin/general" });
  // Legitimately absent when prices are all-inclusive — the copy says so.
  if (!(settings.taxes?.length || settings.fees?.length || settings.cityTax?.enabled)) {
    gaps.push({ key: "taxes", to: "/admin/taxes" });
  }

  return { steps, doneCount, complete: doneCount === steps.length, gaps };
}
