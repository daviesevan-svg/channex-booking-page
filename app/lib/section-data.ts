// The shape of the data website sections render. Pure, so the shared renderer
// can name these types without importing a `*.server` module — an unused
// server-only import still leaks into the client bundle and fails the build.
//
// The loader that fills it in lives in `section-data.server.ts`.

import type { ResolvedGalleryImage } from "./gallery";
import type { OfferView } from "./promotions";

/** One review as the reviews section shows it — a projection, not the stored
 *  record: a loader returning the full row would serialize private fields into
 *  the HTML. */
export interface ReviewView {
  id: string;
  guestName: string;
  stars: number;
  publicText: string;
  response?: { text?: string } | null;
}

/** Matches `RoomCardView` in components/sections — the rooms section's props. */
export interface SectionRoom {
  id: string;
  title: string;
  description?: string;
  photo?: string;
  maxGuests: number;
}

export interface SectionMap {
  lat: number;
  lng: number;
  /** Empty when no Maps key is configured — then there's nothing to click. */
  mapKey: string;
  address?: string;
}

export interface SectionContact {
  address?: string;
  phone?: string;
  email?: string;
  checkinTime?: string;
  checkoutTime?: string;
  /** Mirrors the contact action's own choice of recipient, so the form is only
   *  offered when a submission would actually reach someone. */
  canReceive: boolean;
}

export interface SectionData {
  rooms: SectionRoom[];
  /** Live and upcoming promotions, best first. Empty when the section isn't on
   *  the page — or when the hotel has nothing running, which renders nothing. */
  offers: OfferView[];
  gallery: ResolvedGalleryImage[];
  facilities: string[];
  facilitiesExtra: string[];
  reviews: { average: number; count: number; reviews: ReviewView[] };
  hasVouchers: boolean;
  /** Null when the section isn't present, or the property has no coordinates. */
  map: SectionMap | null;
  contact: SectionContact;
  /** Shown by the gallery section when the property has no gallery images. */
  fallbackPhoto?: string;
  /**
   * Today's date (YYYY-MM-DD) as the server saw it.
   *
   * The offers section says whether an offer is bookable now and how soon the
   * earliest stay is, which is a comparison against today — and a visitor's
   * clock (or timezone) disagreeing with the server's would have it re-render
   * different words on hydration than it served.
   */
  today: string;
}
