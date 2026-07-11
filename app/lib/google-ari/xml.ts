// Google Hotels ARI — OTA/Transaction XML builders.
// https://developers.google.com/hotels/hotel-prices/xml-reference/ari-overview
//
// Pure string builders (no server imports) so they're trivially unit-testable
// and reusable. Each takes already-resolved data + envelope fields and returns a
// complete XML document string. The transport + data-loading live in
// push.server.ts / rates.server.ts.

/** XML-escape text content / attribute values. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Envelope fields stamped on every message. `partner` is the Hotel Center
 *  partner account key; `hotelId` is our property id (matches HLF + structured
 *  data). `id` is a unique message id; `timestamp` an ISO-8601 datetime. */
export interface AriEnvelope {
  partner: string;
  hotelId: string;
  id: string;
  timestamp: string;
}

/** A localized `<Name>`/`<Description>` block. */
function textEl(tag: string, text: string, lang = "en"): string {
  return `    <${tag}><Text text="${esc(text)}" language="${lang}"/></${tag}>\n`;
}

export interface PropertyRoom {
  id: string;
  title: string;
  description?: string;
  /** Max adults the room sleeps. */
  maxAdults: number;
  /** Total heads (adults + children) the room sleeps. */
  maxGuests: number;
  /** Rate-plan (package) ids offered on this room. */
  packageIds: string[];
}

export interface PropertyRate {
  id: string;
  title: string;
  description?: string;
  /** Room ids this rate is offered on. */
  roomIds: string[];
}

/** Transaction (Property Data) message: defines rooms (RoomData) + rate plans
 *  (PackageData) and their mapping. `action="overlay"` fully replaces Google's
 *  stored definitions for the property, so each push is authoritative. */
export function buildPropertyDataXml(
  env: AriEnvelope,
  rooms: PropertyRoom[],
  rates: PropertyRate[],
  times: { checkin?: string; checkout?: string } = {},
): string {
  const roomXml = rooms
    .map((r) => {
      const childCap = Math.max(0, r.maxGuests - r.maxAdults);
      const pkgs = r.packageIds
        .map((id) => `      <AllowablePackageID>${esc(id)}</AllowablePackageID>\n`)
        .join("");
      return (
        `  <RoomData>\n` +
        `    <RoomID>${esc(r.id)}</RoomID>\n` +
        textEl("Name", r.title) +
        (r.description ? textEl("Description", r.description) : "") +
        `    <Capacity>${r.maxGuests}</Capacity>\n` +
        `    <AdultCapacity>${r.maxAdults}</AdultCapacity>\n` +
        // Only when the room actually sleeps children — Google warns on a 0 value.
        (childCap > 0 ? `    <ChildCapacity>${childCap}</ChildCapacity>\n` : "") +
        (pkgs ? `    <AllowablePackageIDs>\n${pkgs}    </AllowablePackageIDs>\n` : "") +
        `  </RoomData>\n`
      );
    })
    .join("");

  const rateXml = rates
    .map((r) => {
      const roomIds = r.roomIds
        .map((id) => `      <AllowableRoomID>${esc(id)}</AllowableRoomID>\n`)
        .join("");
      return (
        `  <PackageData>\n` +
        `    <PackageID>${esc(r.id)}</PackageID>\n` +
        textEl("Name", r.title) +
        (r.description ? textEl("Description", r.description) : "") +
        (roomIds ? `    <AllowableRoomIDs>\n${roomIds}    </AllowableRoomIDs>\n` : "") +
        (times.checkin ? `    <CheckinTime>${esc(times.checkin)}</CheckinTime>\n` : "") +
        (times.checkout ? `    <CheckoutTime>${esc(times.checkout)}</CheckoutTime>\n` : "") +
        `  </PackageData>\n`
      );
    })
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Transaction timestamp="${esc(env.timestamp)}" id="${esc(env.id)}" partner="${esc(env.partner)}">\n` +
    `  <PropertyDataSet action="overlay">\n` +
    `    <Property>${esc(env.hotelId)}</Property>\n` +
    roomXml +
    rateXml +
    `  </PropertyDataSet>\n` +
    `</Transaction>\n`
  );
}

// ---------------------------------------------------------------------------
// OTA messages (rate / availability / inventory). These use the OpenTravel
// envelope: EchoToken/TimeStamp/Version + a POS/RequestorID partner block, with
// the hotel id on the container element.
// ---------------------------------------------------------------------------

const OTA_NS = "http://www.opentravel.org/OTA/2003/05";

function otaHead(root: string, env: AriEnvelope, extraAttrs = ""): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<${root} xmlns="${OTA_NS}" EchoToken="${esc(env.id)}" TimeStamp="${esc(env.timestamp)}" Version="3.0"${extraAttrs}>\n` +
    `  <POS><Source><RequestorID ID="${esc(env.partner)}"/></Source></POS>\n`
  );
}

/** One priced product over a date range: per-guest amounts. */
export interface RateEntry {
  roomId: string;
  rateId: string;
  /** Inclusive YYYY-MM-DD range. */
  start: string;
  end: string;
  currency: string;
  /** Per-occupancy nightly amounts: `net` (ex-VAT) and `gross` (VAT-inclusive). */
  amounts: { guests: number; net: number; gross: number }[];
}

const money = (n: number) => n.toFixed(2);

/** OTA_HotelRateAmountNotifRQ — per-product, per-occupancy nightly rates. We send
 *  both AmountBeforeTax (net — US locales show pre-tax by default) and
 *  AmountAfterTax (VAT-inclusive), so Google displays the room price with VAT
 *  INCLUDED rather than adding it on top. Genuinely-extra fees + city tax still
 *  ride in the separate TaxFeeInfo message (they're added at checkout too). */
export function buildRateAmountXml(env: AriEnvelope, entries: RateEntry[]): string {
  const body = entries
    .map((e) => {
      const amts = e.amounts
        .map(
          (a) =>
            `          <BaseByGuestAmt AmountBeforeTax="${money(a.net)}" AmountAfterTax="${money(a.gross)}" CurrencyCode="${esc(e.currency)}" NumberOfGuests="${a.guests}"/>\n`,
        )
        .join("");
      return (
        `    <RateAmountMessage>\n` +
        `      <StatusApplicationControl Start="${e.start}" End="${e.end}" InvTypeCode="${esc(e.roomId)}" RatePlanCode="${esc(e.rateId)}"/>\n` +
        `      <Rates><Rate>\n` +
        `        <BaseByGuestAmts>\n${amts}        </BaseByGuestAmts>\n` +
        `      </Rate></Rates>\n` +
        `    </RateAmountMessage>\n`
      );
    })
    .join("");
  return (
    otaHead("OTA_HotelRateAmountNotifRQ", env, ` NotifType="Overlay" NotifScopeType="ProductRate"`) +
    `  <RateAmountMessages HotelCode="${esc(env.hotelId)}">\n` +
    body +
    `  </RateAmountMessages>\n` +
    `</OTA_HotelRateAmountNotifRQ>\n`
  );
}

/** Restriction flags for a product over a date range. */
export interface AvailEntry {
  roomId: string;
  rateId: string;
  start: string;
  end: string;
  stopSell: boolean;
  cta: boolean;
  ctd: boolean;
  /** Min length of stay (nights); 1 = no minimum. */
  minStay: number;
}

/** OTA_HotelAvailNotifRQ — availability + restrictions. We send authoritative
 *  open/close for Master (stop-sell), Arrival (CTA), Departure (CTD) and a
 *  SetMinLOS length-of-stay, so lifting a restriction is pushed too. */
export function buildAvailXml(env: AriEnvelope, entries: AvailEntry[]): string {
  const msg = (roomId: string, rateId: string, start: string, end: string, inner: string) =>
    `    <AvailStatusMessage>\n` +
    `      <StatusApplicationControl Start="${start}" End="${end}" InvTypeCode="${esc(roomId)}" RatePlanCode="${esc(rateId)}"/>\n` +
    inner +
    `    </AvailStatusMessage>\n`;
  const body = entries
    .map((e) => {
      const master = `      <RestrictionStatus Status="${e.stopSell ? "Close" : "Open"}" Restriction="Master"/>\n`;
      const arrival = `      <RestrictionStatus Status="${e.cta ? "Close" : "Open"}" Restriction="Arrival"/>\n`;
      const departure = `      <RestrictionStatus Status="${e.ctd ? "Close" : "Open"}" Restriction="Departure"/>\n`;
      const los =
        `      <LengthsOfStay><LengthOfStay Time="${Math.max(1, e.minStay)}" MinMaxMessageType="SetMinLOS"/></LengthsOfStay>\n`;
      return (
        msg(e.roomId, e.rateId, e.start, e.end, master) +
        msg(e.roomId, e.rateId, e.start, e.end, arrival) +
        msg(e.roomId, e.rateId, e.start, e.end, departure) +
        msg(e.roomId, e.rateId, e.start, e.end, los)
      );
    })
    .join("");
  return (
    otaHead("OTA_HotelAvailNotifRQ", env) +
    `  <AvailStatusMessages HotelCode="${esc(env.hotelId)}">\n` +
    body +
    `  </AvailStatusMessages>\n` +
    `</OTA_HotelAvailNotifRQ>\n`
  );
}

/** Physical room count for a room type over a date range. */
export interface InvEntry {
  roomId: string;
  start: string;
  end: string;
  count: number;
}

/** OTA_HotelInvCountNotifRQ — physical inventory (CountType 2 = definite). */
export function buildInvCountXml(env: AriEnvelope, entries: InvEntry[]): string {
  const body = entries
    .map(
      (e) =>
        `    <Inventory>\n` +
        `      <StatusApplicationControl Start="${e.start}" End="${e.end}" InvTypeCode="${esc(e.roomId)}"/>\n` +
        `      <InvCounts><InvCount Count="${Math.max(0, Math.floor(e.count))}" CountType="2"/></InvCounts>\n` +
        `    </Inventory>\n`,
    )
    .join("");
  return (
    otaHead("OTA_HotelInvCountNotifRQ", env) +
    `  <Inventories HotelCode="${esc(env.hotelId)}">\n` +
    body +
    `  </Inventories>\n` +
    `</OTA_HotelInvCountNotifRQ>\n`
  );
}

// ---------------------------------------------------------------------------
// TaxFeeInfo (proprietary envelope). Room rate is pushed net; this tells Google
// the taxes/fees to compose the all-in price.
// ---------------------------------------------------------------------------

export interface TaxLine {
  /** "percent" (of room rate) or "amount" (flat). */
  type: "percent" | "amount";
  /** "room" or "person". */
  basis: "room" | "person";
  /** "stay" or "night". */
  period: "stay" | "night";
  amount: number;
  /** Currency for amount-type lines. */
  currency?: string;
}

/** TaxFeeInfo — VAT as percent taxes, fees + city tax as fee lines. */
export function buildTaxesXml(env: AriEnvelope, taxes: TaxLine[], fees: TaxLine[]): string {
  const line = (tag: "Tax" | "Fee", t: TaxLine) =>
    `      <${tag}>\n` +
    `        <Type>${t.type}</Type>\n` +
    `        <Basis>${t.basis}</Basis>\n` +
    `        <Period>${t.period}</Period>\n` +
    (t.currency ? `        <Currency>${esc(t.currency)}</Currency>\n` : "") +
    `        <Amount>${money(t.amount)}</Amount>\n` +
    `      </${tag}>\n`;
  const taxXml = taxes.map((t) => line("Tax", t)).join("");
  const feeXml = fees.map((f) => line("Fee", f)).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<TaxFeeInfo timestamp="${esc(env.timestamp)}" id="${esc(env.id)}" partner="${esc(env.partner)}">\n` +
    `  <Property>\n` +
    `    <ID>${esc(env.hotelId)}</ID>\n` +
    (taxXml ? `    <Taxes>\n${taxXml}    </Taxes>\n` : "") +
    (feeXml ? `    <Fees>\n${feeXml}    </Fees>\n` : "") +
    `  </Property>\n` +
    `</TaxFeeInfo>\n`
  );
}

// ---------------------------------------------------------------------------
// Promotions (proprietary envelope). Every auto-offer (percent-only) becomes a
// non-combinable promotion, so Google lands on the single best offer — matching
// our engine's bestAutoOffer — rather than stacking multiple.
// ---------------------------------------------------------------------------

export interface PromoEntry {
  id: string;
  percent: number;
  /** Book at least this many days before check-in. */
  minDaysAhead?: number;
  /** Book at most this many days before check-in. */
  maxDaysAhead?: number;
  /** Minimum nights. */
  minNights?: number;
  /** Stay-date window (YYYY-MM-DD). */
  stayFrom?: string;
  stayTo?: string;
}

export function buildPromotionsXml(env: AriEnvelope, promos: PromoEntry[]): string {
  const body = promos
    .map((p) => {
      const bw =
        p.minDaysAhead != null || p.maxDaysAhead != null
          ? `      <BookingWindow${p.minDaysAhead != null ? ` min="${p.minDaysAhead}"` : ""}${p.maxDaysAhead != null ? ` max="${p.maxDaysAhead}"` : ""}/>\n`
          : "";
      const los = p.minNights != null ? `      <LengthOfStay min="${p.minNights}"/>\n` : "";
      const stay =
        p.stayFrom || p.stayTo
          ? `      <StayDates application="overlap"><DateRange start="${esc(p.stayFrom ?? "1970-01-01")}" end="${esc(p.stayTo ?? "2099-12-31")}"/></StayDates>\n`
          : "";
      return (
        `    <Promotion id="${esc(p.id.slice(0, 40))}">\n` +
        bw +
        los +
        stay +
        `      <Discount percentage="${p.percent}"/>\n` +
        `      <Stacking type="none"/>\n` +
        `    </Promotion>\n`
      );
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Promotions partner="${esc(env.partner)}" id="${esc(env.id)}" timestamp="${esc(env.timestamp)}">\n` +
    `  <HotelPromotions hotel_id="${esc(env.hotelId)}">\n` +
    body +
    `  </HotelPromotions>\n` +
    `</Promotions>\n`
  );
}

