// Per-teammate page access, grouped into a few coarse AREAS rather than
// per-page checkboxes (docs/whitelabel.md §4 covers the per-PARTNER layer;
// this is the per-member layer an owner configures on the Team page).
//
// Plain module (no .server) because the Team page and the admin nav render
// the same area list client-side. Enforcement lives in properties.server —
// assertMemberAreaAllowed on the property resolver — never here.
import { routerPath } from "./router-path";

export type MemberArea = "operations" | "pricing" | "website" | "emails" | "payments";

export const MEMBER_AREAS: MemberArea[] = ["operations", "pricing", "website", "emails", "payments"];

/** Path prefixes (full segments) each area owns under /admin. A page absent
 *  from every list — property details, general, portal, team, … — is never
 *  member-restrictable. "/admin/website" deliberately does NOT catch
 *  "/admin/website-widget": matching is exact-or-slash. */
const AREA_PATHS: Record<MemberArea, string[]> = {
  operations: ["/admin/inventory", "/admin/analytics", "/admin/ari-log", "/admin/bookings", "/admin/reviews"],
  pricing: ["/admin/rooms", "/admin/rates", "/admin/taxes", "/admin/promotions", "/admin/extras", "/admin/vouchers"],
  website: ["/admin/website", "/admin/gallery", "/admin/facilities", "/admin/home", "/admin/pages"],
  emails: ["/admin/emails"],
  payments: ["/admin/payments"],
};

export function areaForPathname(pathname: string): MemberArea | null {
  // React Router single-fetch loads "/admin/rates.data" — the SAME loader
  // data as "/admin/rates", so it must map to the same area or client-side
  // navigations walk straight past the guard.
  //
  // Compared as the router reads it — any letter case, percent-escapes decoded
  // (see router-path.ts). The raw path is not what gets served: "/admin/Rates"
  // loads the rates page, and must land in the same area as "/admin/rates".
  const path = routerPath(pathname.replace(/\.data$/, ""));
  for (const area of MEMBER_AREAS) {
    if (AREA_PATHS[area].some((p) => path === p || path.startsWith(`${p}/`))) return area;
  }
  return null;
}

export function isMemberArea(v: string): v is MemberArea {
  return (MEMBER_AREAS as string[]).includes(v);
}
