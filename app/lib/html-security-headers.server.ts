// The partner host pair behind the one cross-origin framing relationship the
// document CSP allows (see html-security-headers.ts): a white-label partner's
// back office and that same partner's guest host, so the design preview can
// render the page it is previewing.
//
// Deliberately narrow about when it looks anything up. Our own hosts are
// single-origin and return immediately; a guest document only pays for the
// lookup when it carries `?preview=`, which is the only guest URL that is ever
// framed from another host. Ordinary guest traffic does no extra reads.

import { isOwnHost } from "./domains.server";
import { frameAncestorsForPath, type PartnerFraming } from "./html-security-headers";
import { getPartner, partnerIdForAdminHost, partnerIdForGuestHost } from "./partners.server";

export async function partnerFramingFor(request: Request): Promise<PartnerFraming> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return {};
  }
  // Our own domain serves both surfaces, so the preview is same-origin there.
  if (isOwnHost(url.hostname)) return {};
  // Same scheme/port as this request, so dev partner hosts work.
  const origin = (host: string) => `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
  const ancestors = frameAncestorsForPath(url.pathname);

  if (ancestors === "none") {
    // An admin document: may it embed its partner's guest host?
    const partner = await getPartner((await partnerIdForAdminHost(url.hostname)) ?? undefined);
    return partner?.guestHost ? { frames: origin(partner.guestHost) } : {};
  }
  if (ancestors !== "self" || !url.searchParams.has("preview")) return {};
  // A guest document being previewed: may its partner's back office embed it?
  const partner = await getPartner((await partnerIdForGuestHost(url.hostname)) ?? undefined);
  return partner?.adminHost ? { framedBy: origin(partner.adminHost) } : {};
}
