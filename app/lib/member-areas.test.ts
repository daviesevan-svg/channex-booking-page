import { matchRoutes, type RouteObject } from "react-router";
import { describe, expect, it } from "vitest";

// The teammate area guard decides by path; the router decides what is served.
// These must be the same reading of the URL. Rather than list spellings by
// hand, this drives the app's real route table through the real matcher: for
// every admin route, every respelling the router still serves must land in the
// same area as the plain URL.
import routeConfig from "../routes";
import { areaForPathname, MEMBER_AREAS } from "./member-areas";

type Entry = { id?: string; path?: string; index?: boolean; file: string; children?: Entry[] };

function toRouteObjects(entries: Entry[]): RouteObject[] {
  return entries.map((e) =>
    e.index
      ? { id: e.id ?? e.file, index: true }
      : { id: e.id ?? e.file, path: e.path, children: e.children ? toRouteObjects(e.children) : undefined },
  );
}

/** Every full URL pattern in the tree, params filled in. */
function urls(entries: Entry[], base = ""): string[] {
  return entries.flatMap((e) => {
    const here = e.path ? `${base}/${e.path}` : base;
    return [...(e.path || e.index ? [here || "/"] : []), ...(e.children ? urls(e.children, here) : [])];
  });
}

/** What the server does to the request path before matching (single-fetch). */
const served = (path: string) => (path.endsWith("/_.data") ? path.replace(/_\.data$/, "") : path.replace(/\.data$/, ""));

const escapeAt = (s: string, i: number) => `${s.slice(0, i)}%${s.charCodeAt(i).toString(16)}${s.slice(i + 1)}`;
const afterAdmin = "/admin/".length;

const RESPELLINGS: Record<string, (u: string) => string> = {
  "upper case": (u) => u.toUpperCase(),
  "capitalised page": (u) => u.slice(0, afterAdmin) + u.charAt(afterAdmin).toUpperCase() + u.slice(afterAdmin + 1),
  "capitalised Admin": (u) => u.replace("/admin", "/Admin"),
  "escaped letter": (u) => escapeAt(u, afterAdmin),
  "escaped letter in admin": (u) => escapeAt(u, 1),
  "escaped upper-case letter": (u) => escapeAt(u.slice(0, afterAdmin) + u.charAt(afterAdmin).toUpperCase() + u.slice(afterAdmin + 1), afterAdmin),
  "trailing slash": (u) => `${u}/`,
  "data request": (u) => `${u}.data`,
  "upper-case data request": (u) => `${u.toUpperCase()}.data`,
  "trailing-slash data request": (u) => `${u}/_.data`,
};

const entries = (await routeConfig) as Entry[];
const routes = toRouteObjects(entries);
const adminUrls = urls(entries)
  .filter((u) => u.startsWith("/admin/"))
  .map((u) => u.replace(/:[\w-]+\??/g, "x1").replace(/\*$/, "x1"));
const leaf = (path: string) => matchRoutes(routes, served(path))?.at(-1)?.route.id;

describe("areaForPathname reads the URL the way the router does", () => {
  it("covers a real route in every area (the table below is not vacuous)", () => {
    const areas = new Set(adminUrls.map((u) => areaForPathname(u)));
    for (const area of MEMBER_AREAS) expect(areas).toContain(area);
  });

  for (const [name, respell] of Object.entries(RESPELLINGS)) {
    it(`${name}: a URL that still serves the page is still in the page's area`, () => {
      let servedCount = 0;
      const escaped: string[] = [];
      for (const u of adminUrls) {
        const variant = respell(u);
        if (leaf(variant) !== leaf(u)) continue; // the router does not serve it
        servedCount++;
        if (areaForPathname(variant) !== areaForPathname(u)) escaped.push(`${variant} (${areaForPathname(u)})`);
      }
      expect(servedCount).toBeGreaterThan(0);
      expect(escaped).toEqual([]);
    });
  }

  it("still tells neighbours apart", () => {
    expect(areaForPathname("/admin/website-widget")).toBeNull();
    expect(areaForPathname("/admin/Website-Widget")).toBeNull();
    expect(areaForPathname("/admin/team")).toBeNull();
  });
});
