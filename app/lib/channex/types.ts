// Channex Shopping API response/request types (camelCased to match the client,
// which converts wire snake_case -> camelCase). Derived from docs.channex.io
// and the legacy instant_booking_page consumers.
import type { OccupancyPricing } from "../rate-pricing";

export interface Photo {
  url: string;
  title?: string | null;
  author?: string | null;
  position?: number;
}

export interface HotelPolicy {
  title?: string;
  currency?: string;
  checkinFromTime?: string;
  checkinToTime?: string;
  checkoutFromTime?: string;
  checkoutToTime?: string;
  childrenMaxAge?: number | null;
  infantMaxAge?: number | null;
  maxCountOfGuests?: number;
  isAdultsOnly?: boolean;
  internetAccessType?: string | null;
  internetAccessCost?: string | null;
  internetAccessCoverage?: string | null;
  parkingType?: string | null;
  parkingReservation?: string | null;
  parkingIsPrivate?: boolean;
  petsPolicy?: string | null;
  petsNonRefundableFee?: string | null;
  petsRefundableDeposit?: string | null;
  smokingPolicy?: string | null;
}

export interface FacilityCategory {
  categoryCode: string;
  facilities: string[];
}

export interface PropertyInfo {
  id: string;
  title: string;
  description?: string;
  address?: string;
  city?: string;
  state?: string | null;
  country?: string;
  zipCode?: string;
  location?: { latitude: string; longitude: string } | null;
  facilities?: FacilityCategory[];
  photos?: Photo[];
  logo?: string | null;
  currency?: string;
  email?: string;
  phone?: string;
  timezone?: string;
  hideLogo?: boolean;
  hideTitle?: boolean;
  exactMatch?: boolean;
  requestBillingInfo?: boolean;
  requestCreditCard?: boolean;
  hotelPolicy?: HotelPolicy;
}

export interface ClosedDates {
  closed: string[];
  closedToArrival: string[];
  closedToDeparture: string[];
  minStayArrival: Record<string, number>;
  minStayThrough: Record<string, number>;
}

export interface Occupancy {
  adults: number;
  children: number;
  infants: number;
}

export interface CancellationPolicy {
  title?: string;
  currency?: string;
  cancellationPolicyLogic?: string;
  cancellationPolicyMode?: string;
  cancellationPolicyDeadline?: number | null;
  cancellationPolicyDeadlineType?: string | null;
  cancellationPolicyPenalty?: string | null;
  guaranteePaymentPolicy?: string;
  guaranteePaymentAmount?: string | null;
  nonShowPolicy?: string;
}

export interface Tax {
  title: string;
  amount: string;
  rate?: string;
  mode?: "percent" | "fixed" | string;
  inclusive: boolean;
  type?: string;
  isInclusive?: boolean;
}

export interface RatePlan {
  id: string;
  title: string;
  occupancy: Occupancy;
  mealPlan?: string | null;
  currency?: string;
  /** Gross price for the whole stay (tax-inclusive where applicable). */
  totalPrice: string;
  /** Net price for the whole stay. */
  netPrice?: string;
  lengthOfStay?: number;
  infantFee?: string;
  childrenFee?: string;
  /** Rooms left to sell at this rate (virtual rate plans of a room share inventory). */
  availability?: number;
  taxes?: Tax[];
  cancellationPolicy?: CancellationPolicy;
  /** Stable id of the logical rate plan; virtual per-occupancy variants share it.
   *  Used as the mapping key for admin rate-plan content overrides. */
  parentRatePlanId?: string;
  mealType?: string | null;
  isPrimary?: boolean;
  virtualId?: string | null;
  // Admin content overrides (applied server-side, not returned by Channex):
  description?: string;
  inclusions?: string[];
  images?: string[];
  /** Custom cancellation text shown verbatim to guests (overrides the policy title). */
  cancellationNote?: string;
  /** Whether the rate is refundable, and the free-cancel deadline (ISO), derived
   *  from the rate policy so the rate card can show it. */
  refundable?: boolean;
  freeCancelUntilISO?: string | null;
  /** The deadline as the hotel's wall clock ("2026-08-09T18:00"), for display —
   *  see CancellationLike.cancelByLocal. */
  freeCancelUntilLocal?: string | null;
  /** Automatic offer baked into totalPrice (set by getCatalogRooms). The
   *  original (pre-discount) price is kept so the UI can show the saving. */
  offer?: { name: string; percent: number; originalTotalPrice: string };
  /**
   * Value-added offers that apply to this stay (set by getCatalogRooms).
   *
   * Alongside `offer`, never inside it: these change what's included, not the
   * price, and a stay can have both. Kept out of `inclusions` too — that field is
   * the rate's own admin content ("In this room"), so a stay-level offer landing
   * in it would look like the hotel had edited the rate, and would be wrong the
   * moment the same rate is searched for different dates.
   */
  valueAdds?: { name: string; inclusions: string[] }[];
  /** Per-person pricing rules (set by getCatalogRooms from the rate), so the
   *  detail page can re-price live for a chosen room occupancy. */
  occupancyPricing?: OccupancyPricing;
  /** True for a per-person rate: the price is per number of ADULTS (from
   *  Channex per-occupancy pushes, or a per-adult base price). Children still
   *  price via `occupancyPricing`'s age bands. */
  perPerson?: boolean;
  /** Per-person rates only: room-only stay total for each adults count
   *  (1..maxAdults), pre-offer — the detail page re-prices from these because a
   *  per-person rate's prices vary by date, so a flat nightly delta can't. */
  perPersonTotals?: Record<number, number>;
  /** Tax-/fee-inclusive stay total (set by the results loader via computePricing)
   *  — the all-in price shown to guests and emitted in Google structured data so
   *  it matches the checkout total. `allInOriginal` is the pre-discount equivalent. */
  allInTotal?: number;
  allInOriginal?: number;
}

export interface BedOption {
  title: string;
  count: number;
  size?: string;
}

export interface RoomSpace {
  id?: string;
  count?: number;
  bedOptions?: BedOption[];
}

export interface RoomWithRates {
  id: string;
  title: string;
  description?: string;
  spaces?: RoomSpace[];
  facilities?: string[];
  /** Structured amenity keys (Google vocabulary — see VR_AMENITIES). */
  amenities?: string[];
  photos?: Photo[];
  codes?: Record<string, unknown>;
  isBestOffer?: boolean;
  /** Flat cleaning fee per room per stay (from the manual catalog). */
  cleaningFee?: number;
  ratePlans: RatePlan[];
}

export interface PropertyListItem {
  id: string;
  title: string;
  description?: string;
  address?: string;
  city?: string;
  state?: string | null;
  country?: string;
  zipCode?: string;
  latitude?: string;
  longitude?: string;
  photos?: Photo[];
  bestOffer?: string | null;
}

export interface RoomsQuery {
  checkinDate?: string;
  checkoutDate?: string;
  currency?: string;
  adults?: number;
  childrenAge?: number[];
}
