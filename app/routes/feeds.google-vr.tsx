// Public Google Vacation Rentals list feed, served as XML for Google's scheduled
// pull. Registered at /feeds/google-vacation-rentals.xml in routes.ts. Resource
// route: a loader returning a Response, no component.
import { buildVrListFeed } from "~/lib/vr-list-feed.server";

export async function loader() {
  const xml = await buildVrListFeed();
  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      // Google pulls on a schedule; a short cache is plenty and keeps it fresh.
      "Cache-Control": "public, max-age=3600",
    },
  });
}
