// The cart keyed by its `sel` token, for the add/remove diff.
//
// Its own module because three funnel loaders need it and none of them owns it.
// The keys come from the same serializer the URL uses, so they match the tokens
// the guest's address bar actually carries — a hand-built key would drift the
// first time the token format gained a segment, and the symptom would be silent
// (every add reported as an unnamed item, or not at all).
import { serializeCart, type ResolvedLine } from "./cart";

export interface TokenLine {
  roomId: string;
  roomTitle: string;
  rateTitle: string;
  total: number;
}

export function cartTokenMap(lines: ResolvedLine[]): Record<string, TokenLine> {
  const out: Record<string, TokenLine> = {};
  for (const l of lines) {
    const token = serializeCart([
      { roomId: l.roomId, rateId: l.rateId, adults: l.adults, childrenAge: l.childrenAge },
    ]);
    out[token] = { roomId: l.roomId, roomTitle: l.roomTitle, rateTitle: l.rateTitle, total: l.total };
  }
  return out;
}
