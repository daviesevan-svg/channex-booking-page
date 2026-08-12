// The new-property setup checklist: what still stands between this property
// and a real, paid, guest-visible booking.
//
// Every step is DERIVED from the stored data at render time — there is no
// stored todo state to drift out of sync, no "mark as done" to lie with. The
// list names the exact gates the booking engine actually enforces: a night
// with no inventory row counts as 0 (ari.server), a room with no priced rate
// never renders, checkout without a Stripe account can only simulate, and a
// property with liveBooking off tells guests it's in test mode.
import { format, addDays } from "date-fns";

import { getInventory, getLastAriReceivedAt } from "./ari.server";
import { getRates, getRooms } from "./catalog.server";
import { getGalleryFor } from "./gallery.server";
import { getHeroImage, getOverrides, getSettings } from "./overrides.server";
import { getProperty } from "./properties.server";

export interface SetupStep {
  key: "basics" | "rooms" | "prices" | "availability" | "payments" | "website" | "golive";
  done: boolean;
  /** Admin page that completes the step. */
  to: string;
}

export interface SetupChecklist {
  steps: SetupStep[];
  doneCount: number;
  complete: boolean;
}

export async function setupChecklist(pid: string): Promise<SetupChecklist> {
  const [settings, overrides, property, rooms, rates, hero, gallery] = await Promise.all([
    getSettings(pid),
    getOverrides(pid),
    getProperty(pid),
    getRooms(pid),
    getRates(pid),
    getHeroImage(pid),
    getGalleryFor(pid),
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
  // for any open night in the next 30 days.
  let hasAvailability = false;
  if (channex) {
    hasAvailability = (await getLastAriReceivedAt(pid)) != null;
  } else if (rooms.length > 0) {
    const from = format(new Date(), "yyyy-MM-dd");
    const to = format(addDays(new Date(), 30), "yyyy-MM-dd");
    const inv = await getInventory(pid, from, to);
    hasAvailability = Object.values(inv.availability).some((n) => n > 0);
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
    { key: "payments", done: Boolean(settings.stripeAccountId), to: "/admin/payments" },
    { key: "website", done: Boolean(property?.slug), to: "/admin/general" },
    { key: "golive", done: settings.liveBooking === true, to: "/admin/general" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return { steps, doneCount, complete: doneCount === steps.length };
}
