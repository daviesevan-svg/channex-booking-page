// Per-partner page access (docs/whitelabel.md §4). A partner can hide admin
// pages from its hotel users (the PMS pre-wires connectivity, owns the
// developer surface, and platform features have no life under a partner).
//
// This is ACCESS CONTROL, not navigation: every gated route calls
// requirePageAllowed in its LOADER. Hiding the nav item alone would repeat the
// wildcard-route mistake — a link you don't render is not a page you can't open.
//
// Lives in its own module because the natural homes cycle: auth.server already
// imports partners.server (brandForUser), and partners.server can't import
// auth.server back.
import { getAdminEmail } from "./auth.server";
import { getPartner } from "./partners.server";
import { getUser, isSuperadmin } from "./users.server";

/** Ids of the admin pages a partner may hide — the nav items in
 *  layout.tsx carry the same ids. Adding a gate = add the id here, call
 *  requirePageAllowed in the route's loader, tag the nav item. */
export type PageId =
  | "connectivity"
  | "api-keys"
  | "webhooks"
  | "google-hotels"
  | "brand-kit"
  | "collections";

/** The pages hidden from this user by their partner (empty for direct users,
 *  superadmins, and partner_admins — the admins chose the list, it doesn't
 *  apply to them). Used by the layout to filter the nav. */
export async function hiddenPagesFor(email: string): Promise<string[]> {
  if (await isSuperadmin(email)) return [];
  const user = await getUser(email);
  if (!user?.partnerId || user.role === "partner_admin") return [];
  return (await getPartner(user.partnerId))?.hiddenPages ?? [];
}

/** 404s when the signed-in user's partner hides this page. 404 rather than
 *  redirect: to a hotel under a partner the page does not exist, and a
 *  redirect would advertise that it does. */
export async function requirePageAllowed(request: Request, page: PageId): Promise<void> {
  const email = await getAdminEmail(request);
  if (!email) return; // no session — the route's own auth guard handles it
  const hidden = await hiddenPagesFor(email);
  if (hidden.includes(page)) throw new Response("Not found", { status: 404 });
}
