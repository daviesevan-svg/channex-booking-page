// Google Hotel price structured data (JSON-LD).
// https://developers.google.com/hotels/hotel-prices/structured-data/hotel-price-structured-data
//
// Emits a schema.org `Hotel` with either room-level offers (`containsPlace` →
// `HotelRoom[]`, used on results/detail) or a single hotel-level offer
// (`makesOffer`, used at checkout for the final all-in total). Every price is
// tax-inclusive and matches the number shown on the page, as Google requires.
//
// Built in loaders only (this is a .server module); the route component renders
// the returned plain object inside a <script type="application/ld+json">.
import { getConfig } from "./config.server";
import { getOverrides, getSettings } from "./overrides.server";

// Industry-standard fallbacks when a property hasn't set its own times. The
// Offer requires both as date-times.
const CHECKIN_TIME = "15:00:00";
const CHECKOUT_TIME = "11:00:00";

const round2 = (n: number) => Math.round(n * 100) / 100;

// Settings store "HH:MM"; structured data wants "HH:MM:SS".
const toSeconds = (t: string | undefined, fallback: string) =>
  t && /^\d{2}:\d{2}$/.test(t) ? `${t}:00` : t || fallback;

export interface JsonLdOffer {
  /** Rate-plan identifier (optional; helps Google match feed rate plans). */
  rateId?: string;
  /** All-in stay total, tax/fee inclusive. */
  total: number;
}
export interface JsonLdRoom {
  roomId: string;
  name: string;
  /** Max occupancy the price is for. */
  occupancy?: number;
  /** First room photo (absolute or site-relative); emitted as the Product image. */
  image?: string;
  offers: JsonLdOffer[];
}
interface Stay {
  checkin: string; // yyyy-MM-dd
  checkout: string;
}

interface HotelInfo {
  enabled: boolean;
  identifier: string;
  name: string;
  address?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  currency: string;
  checkinTime: string;
  checkoutTime: string;
}

async function hotelInfo(pid: string, lang: string): Promise<HotelInfo> {
  const [settings, overrides] = await Promise.all([getSettings(pid), getOverrides(pid, lang)]);
  return {
    enabled: settings.googleStructuredData !== false, // undefined = on
    identifier: pid,
    name: overrides.hotelName || "Hotel",
    address: overrides.address,
    city: settings.addressCity,
    region: settings.addressRegion,
    postalCode: settings.addressPostalCode,
    country: settings.addressCountry,
    currency: settings.currency || "GBP",
    checkinTime: toSeconds(settings.checkinTime, CHECKIN_TIME),
    checkoutTime: toSeconds(settings.checkoutTime, CHECKOUT_TIME),
  };
}

function baseHotel(info: HotelInfo): Record<string, unknown> {
  const hotel: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Hotel",
    name: info.name,
    identifier: info.identifier,
  };
  // Full PostalAddress from the property's structured location (recommended by
  // Google's hotel-price spec). streetAddress falls back to the freeform line.
  const addr: Record<string, unknown> = { "@type": "PostalAddress" };
  if (info.address) addr.streetAddress = info.address;
  if (info.city) addr.addressLocality = info.city;
  if (info.region) addr.addressRegion = info.region;
  if (info.postalCode) addr.postalCode = info.postalCode;
  if (info.country) addr.addressCountry = info.country;
  if (Object.keys(addr).length > 1) hotel.address = addr;
  return hotel;
}

function offer(stay: Stay, info: HotelInfo, o: JsonLdOffer): Record<string, unknown> {
  return {
    "@type": ["Offer", "LodgingReservation"],
    ...(o.rateId ? { identifier: o.rateId } : {}),
    checkinTime: `${stay.checkin} ${info.checkinTime}`,
    checkoutTime: `${stay.checkout} ${info.checkoutTime}`,
    priceSpecification: {
      "@type": "CompoundPriceSpecification",
      price: round2(o.total),
      priceCurrency: info.currency,
      valueAddedTaxIncluded: true, // our totals are always tax/fee inclusive
    },
  };
}

/** Results / detail: a Hotel whose rooms each carry their priced offers. */
export async function catalogHotelJsonLd(
  pid: string,
  lang: string,
  stay: Stay,
  rooms: JsonLdRoom[],
): Promise<Record<string, unknown> | null> {
  const info = await hotelInfo(pid, lang);
  if (!info.enabled) return null;
  const places = rooms
    .map((r) => ({ ...r, offers: r.offers.filter((o) => o.total > 0) }))
    .filter((r) => r.offers.length > 0)
    .map((r) => {
      // ["HotelRoom","Product"] per Google's hotel-price spec (the generic Rich
      // Results test judges this as a merchant Product and complains, but that
      // test isn't the validator for hotel prices — Hotel Center is).
      const room: Record<string, unknown> = {
        "@type": ["HotelRoom", "Product"],
        name: r.name,
        identifier: r.roomId,
      };
      // Product recommends an image — emit the room's first photo, absolutised.
      if (r.image) {
        room.image = /^https?:\/\//.test(r.image)
          ? r.image
          : `${getConfig().appUrl.replace(/\/+$/, "")}${r.image.startsWith("/") ? "" : "/"}${r.image}`;
      }
      if (r.occupancy && r.occupancy > 0) {
        room.occupancy = { "@type": "QuantitativeValue", value: r.occupancy };
      }
      const offers = r.offers.map((o) => offer(stay, info, o));
      room.offers = offers.length === 1 ? offers[0] : offers;
      return room;
    });
  if (places.length === 0) return null;
  return { ...baseHotel(info), containsPlace: places.length === 1 ? places[0] : places };
}

/** Checkout: a single hotel-level offer carrying the final all-in total the
 *  guest sees — so Google's price matches right through to the last step. */
export async function reservationHotelJsonLd(
  pid: string,
  lang: string,
  stay: Stay,
  total: number,
): Promise<Record<string, unknown> | null> {
  const info = await hotelInfo(pid, lang);
  if (!info.enabled || !(total > 0)) return null;
  return { ...baseHotel(info), makesOffer: offer(stay, info, { total }) };
}
