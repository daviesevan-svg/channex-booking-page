import type { Route } from "./+types/api.v1.manage.reviews";
import { authenticateApiKey } from "~/lib/api-auth.server";
import { listReviews } from "~/lib/reviews.server";

// GET /v1/manage/reviews — the admin view: every review (including ones
// without public text), with the private note. Write surface is response-only
// (see the :bookingId route) — a property can respond to a review, never hide
// or delete one.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const reviews = await listReviews(auth.pid);
  return Response.json({
    data: reviews.map((r) => ({
      booking_id: r.bookingId,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      stars: r.stars,
      categories: r.categories,
      public_text: r.publicText ?? null,
      private_note: r.privateNote ?? null,
      guest_name: r.guestName,
      checkin: r.checkin,
      checkout: r.checkout,
      response: r.response ? { text: r.response.text, at: r.response.at } : null,
    })),
  });
}
