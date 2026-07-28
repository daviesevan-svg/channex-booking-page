// The shape of the data website sections render. Pure, so the shared renderer
// can name these types without importing a `*.server` module — an unused
// server-only import still leaks into the client bundle and fails the build.
//
// The loader that fills it in lives in `section-data.server.ts`.

import type { ResolvedGalleryImage } from "./gallery";

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
}
