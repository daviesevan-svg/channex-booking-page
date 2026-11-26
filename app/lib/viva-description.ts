/** Viva order descriptions (`customerTrns` / `merchantTrns`) are passed on to
 *  local payment schemes. MB WAY's processor (SIBS) refuses the order, and the
 *  hosted page simply closes, when the description is 70 characters or longer
 *  or contains anything but letters and numbers (Viva support, 2026-11). We
 *  can't know the guest's payment method when the order is created, so every
 *  description is made safe for the strictest scheme.
 *
 *  Accents are folded to their base letter ("Pensão" → "Pensao"); any other
 *  character becomes a space; runs of spaces collapse. The result is cut at a
 *  word boundary to at most VIVA_DESCRIPTION_MAX characters. */
export const VIVA_DESCRIPTION_MAX = 64;

export function vivaDescription(text: string, fallback = "Booking"): string {
  const plain = text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/ß/g, "ss")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim();
  if (!plain) return fallback;
  if (plain.length <= VIVA_DESCRIPTION_MAX) return plain;
  const cut = plain.slice(0, VIVA_DESCRIPTION_MAX + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, VIVA_DESCRIPTION_MAX)).trim();
}
