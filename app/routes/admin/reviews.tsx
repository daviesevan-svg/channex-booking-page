// Admin · Reviews — everything guests submitted for the current property:
// overall + category stars, the public text, and the private note (clearly
// marked — it is never shown publicly). The hotel can publish a public response
// — nothing more. Reviews are deliberately immutable to the property: it cannot
// hide or delete them, so it can't bury criticism or cherry-pick its rating.
import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/reviews";
import { getAdminEmail, requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, isOwnerOrSuper } from "~/lib/properties.server";
import { listReviews, setReviewResponse } from "~/lib/reviews.server";
import { REVIEW_CATEGORIES } from "~/lib/reviews";
import { fmtDate } from "~/lib/dates";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  return { configured: true as const, reviews: await listReviews(propertyId) };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "Add a property first." };
  // Publishing a response is an owner call, not a teammate's. There is no hide
  // or delete — a property can only respond, never remove a review.
  if (!(await isOwnerOrSuper(request, propertyId))) {
    return { error: "Only an owner or manager can respond to reviews." };
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const bookingId = String(form.get("bookingId") ?? "");

  if (intent === "respond") {
    const by = (await getAdminEmail(request)) ?? undefined;
    await setReviewResponse(propertyId, bookingId, String(form.get("text") ?? ""), by);
    return { ok: true as const };
  }
  return { error: "Unknown action." };
}

export function meta() {
  return [{ title: "Admin · Reviews" }];
}

const CATEGORY_LABELS: Record<string, string> = {
  value: "Value",
  clean: "Cleanliness",
  location: "Location",
  comfort: "Comfort",
  facilities: "Facilities",
  staff: "Staff",
};

function StarRow({ n, size = 15 }: { n: number; size?: number }) {
  return (
    <span style={{ fontSize: size, letterSpacing: 1 }} aria-label={`${n}/5`}>
      <span style={{ color: "#f5b301" }}>{"★".repeat(n)}</span>
      <span style={{ color: "#ddd5c8" }}>{"★".repeat(5 - n)}</span>
    </span>
  );
}

export default function AdminReviews({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Reviews</h1>
        <p className="text-[15px] text-secondary">Add a property first.</p>
      </div>
    );
  }

  const { reviews } = loaderData;
  const average = reviews.length
    ? Math.round((reviews.reduce((s, r) => s + r.stars, 0) / reviews.length) * 10) / 10
    : null;

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between">
        <h1 className="font-serif text-[26px] font-semibold">Reviews</h1>
        {average != null && (
          <span className="text-[14px] text-secondary">
            <span className="font-serif text-[22px] font-semibold text-ink">{average}</span> / 5 ·{" "}
            {reviews.length} review{reviews.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <p className="rounded-[10px] border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-700">
          {actionData.error}
        </p>
      )}

      {reviews.length === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-6 text-[14px] text-secondary">
          No reviews yet. Guests are emailed a review request on the evening of their checkout day
          (with up to two reminders), so reviews appear here automatically after real stays.
        </div>
      ) : (
        reviews.map((r) => (
          <section key={r.id} className="rounded-[14px] border border-line bg-surface p-6">
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <StarRow n={r.stars} size={18} />
              <span className="font-semibold">{r.guestName}</span>
              <span className="text-[12.5px] text-muted-2">
                {fmtDate(r.checkin, "d MMM")} — {fmtDate(r.checkout, "d MMM yyyy")} · reviewed{" "}
                {fmtDate(r.createdAt, "d MMM yyyy")}
              </span>
            </div>

            {Object.keys(r.categories).length > 0 && (
              <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-secondary">
                {REVIEW_CATEGORIES.filter((c) => r.categories[c]).map((c) => (
                  <span key={c} className="flex items-center gap-1.5">
                    {CATEGORY_LABELS[c]} <StarRow n={r.categories[c]!} size={12} />
                  </span>
                ))}
              </div>
            )}

            {r.publicText && <p className="mb-3 max-w-2xl text-[14.5px] leading-[1.6]">{r.publicText}</p>}
            {r.privateNote && (
              <div className="mb-3 max-w-2xl rounded-[10px] border border-[#e7d3a3] bg-[#fbf4e6] px-4 py-3">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#8a6a23]">
                  Private note — only you can see this
                </div>
                <p className="text-[13.5px] leading-[1.6] text-[#6a5a2e]">{r.privateNote}</p>
              </div>
            )}

            {/* Public response — the only action a property can take on a review. */}
            <Form method="post" className="max-w-2xl">
              <input type="hidden" name="intent" value="respond" />
              <input type="hidden" name="bookingId" value={r.bookingId} />
              <label className="mb-1 block text-[12px] font-semibold uppercase tracking-wide text-muted-2">
                Your public response
              </label>
              <textarea
                name="text"
                rows={2}
                defaultValue={r.response?.text ?? ""}
                placeholder="Thank the guest, address their feedback…"
                className="w-full resize-y rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-2.5 text-[13.5px] outline-none focus:border-accent"
              />
              <div className="mt-1.5 flex items-center gap-3">
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-[8px] border border-line-alt bg-surface px-3.5 py-1.5 text-[12.5px] font-semibold text-secondary hover:border-accent hover:text-accent disabled:opacity-60"
                >
                  {r.response ? "Update response" : "Publish response"}
                </button>
                {r.response && (
                  <span className="text-[11.5px] text-muted-2">
                    Published {fmtDate(r.response.at, "d MMM yyyy")} — clear the text and save to remove it.
                  </span>
                )}
              </div>
            </Form>
          </section>
        ))
      )}
    </div>
  );
}
