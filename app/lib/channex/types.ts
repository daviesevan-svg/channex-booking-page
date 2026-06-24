// Channex Shopping API response/request types (camelCased to match the client,
// which converts wire snake_case -> camelCase). Derived from docs.channex.io
// and the legacy instant_booking_page consumers.

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
  photos?: Photo[];
  codes?: Record<string, unknown>;
  isBestOffer?: boolean;
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
