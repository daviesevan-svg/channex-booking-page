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
        `    <ChildCapacity>${childCap}</ChildCapacity>\n` +
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
