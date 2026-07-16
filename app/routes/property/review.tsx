// Guest review page — reached from the review-request email (each star in the
// email deep-links here with ?stars=N prefilled). The unguessable booking id is
// the credential: it was only ever sent to the guest's own inbox, and the worst
// a holder can do is write a review (unlike /manage, which can cancel/refund
// and therefore requires the email sign-in).
import { useState } from "react";
import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/review";
import { getBooking } from "~/lib/bookings.server";
import { getReviewByBooking, upsertReview } from "~/lib/reviews.server";
import { REVIEW_CATEGORIES, type ReviewCategory } from "~/lib/reviews";
import { resolvePropertyId } from "~/lib/properties.server";
import { useProperty } from "~/lib/booking-context";
import { fmtDate } from "~/lib/dates";
import { useT } from "~/lib/i18n";

const clampStars = (v: unknown): number | undefined => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : undefined;
};

export async function loader({ params, request }: Route.LoaderArgs) {
  const pid = await resolvePropertyId(params.channelId);
  const booking = await getBooking(pid, params.bookingId);
  if (!booking) throw new Response("Not found", { status: 404 });
  const review = await getReviewByBooking(pid, booking.id);
  const url = new URL(request.url);
  return {
    checkin: booking.checkin,
    checkout: booking.checkout,
    firstName: booking.guest.firstName,
    // Prefill priority: the guest's saved review, else the star they tapped.
    initialStars: review?.stars ?? clampStars(url.searchParams.get("stars")) ?? 0,
    initialCategories: review?.categories ?? {},
    initialPublicText: review?.publicText ?? "",
    initialPrivateNote: review?.privateNote ?? "",
    hasReview: Boolean(review),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const pid = await resolvePropertyId(params.channelId);
  const booking = await getBooking(pid, params.bookingId);
  if (!booking) throw new Response("Not found", { status: 404 });

  const form = await request.formData();
  const stars = clampStars(form.get("stars"));
  if (!stars) return { error: "stars" as const };
  const categories: Partial<Record<ReviewCategory, number>> = {};
  for (const c of REVIEW_CATEGORIES) {
    const v = clampStars(form.get(`cat_${c}`));
    if (v) categories[c] = v;
  }
  const text = (name: string) => String(form.get(name) ?? "").trim().slice(0, 4000);

  await upsertReview(pid, {
    bookingId: booking.id,
    stars,
    categories,
    publicText: text("publicText") || undefined,
    privateNote: text("privateNote") || undefined,
    guestName: `${booking.guest.firstName} ${booking.guest.lastName.trim().charAt(0)}.`.trim(),
    checkin: booking.checkin,
    checkout: booking.checkout,
  });
  return { ok: true as const };
}

export function meta() {
  return [{ title: "Review your stay" }];
}

/** Accessible 1–5 star picker backed by a hidden input (no JS = keyboardable
 *  buttons still set state before submit; the server re-validates anyway). */
function Stars({
  name,
  value,
  onChange,
  size = 30,
}: {
  name: string;
  value: number;
  onChange: (v: number) => void;
  size?: number;
}) {
  return (
    <div className="flex items-center gap-1">
      <input type="hidden" name={name} value={value || ""} />
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-label={`${n}/5`}
          onClick={() => onChange(n)}
          className="leading-none transition-transform hover:scale-110"
          style={{ fontSize: size, color: n <= value ? "#f5b301" : "#ddd5c8" }}
        >
          ★
        </button>
      ))}
    </div>
  );
}

export default function Review({ loaderData, actionData }: Route.ComponentProps) {
  const { hotelName } = useProperty();
  const tr = useT();
  const nav = useNavigation();
  const submitting = nav.state === "submitting";
  const [stars, setStars] = useState(loaderData.initialStars);
  const [cats, setCats] = useState<Record<string, number>>(loaderData.initialCategories as Record<string, number>);

  if (actionData && "ok" in actionData && actionData.ok) {
    return (
      <main className="mx-auto max-w-[640px] px-7 pb-[72px] pt-16 text-center">
        <div className="mb-4 text-[44px]">🎉</div>
        <h1 className="mb-3 font-serif text-[32px] font-medium">{tr.t("reviewThanksTitle")}</h1>
        <p className="text-[15px] leading-[1.65] text-secondary">{tr.t("reviewThanksBody")}</p>
      </main>
    );
  }

  const label = "mb-1.5 block text-[13px] font-semibold text-secondary";
  return (
    <main className="mx-auto max-w-[640px] px-7 pb-[72px] pt-10">
      <h1 className="mb-2 font-serif text-[34px] font-medium tracking-[-0.02em]">{tr.t("reviewHeading")}</h1>
      <p className="mb-1 text-[15px] text-secondary">{tr.t("reviewIntro", { hotel: hotelName })}</p>
      <p className="mb-7 text-[13px] text-muted-2">
        {fmtDate(loaderData.checkin, "d MMM")} — {fmtDate(loaderData.checkout, "d MMM yyyy")}
      </p>

      <Form method="post" className="flex flex-col gap-6 rounded-[16px] border border-line bg-surface p-[26px]">
        <div>
          <div className={label}>{tr.t("overallRating")}</div>
          <Stars name="stars" value={stars} onChange={setStars} size={38} />
          {actionData && "error" in actionData && actionData.error === "stars" && (
            <p className="mt-1.5 text-[13px] text-[#c0392b]">{tr.t("reviewStarsRequired")}</p>
          )}
        </div>

        <div>
          <div className={`${label} mb-3`}>{tr.t("rateCategories")}</div>
          <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
            {REVIEW_CATEGORIES.map((c) => (
              <div key={c} className="flex items-center justify-between gap-3">
                <span className="text-[14px] text-secondary">{tr.t(`cat_${c}`)}</span>
                <Stars name={`cat_${c}`} value={cats[c] ?? 0} onChange={(v) => setCats((p) => ({ ...p, [c]: v }))} size={22} />
              </div>
            ))}
          </div>
        </div>

        <label className="block">
          <span className={label}>{tr.t("publicReviewLabel")}</span>
          <textarea
            name="publicText"
            rows={5}
            defaultValue={loaderData.initialPublicText}
            className="w-full resize-y rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-3 text-[15px] outline-none focus:border-accent"
          />
          <span className="mt-1 block text-[12px] text-muted">{tr.t("publicReviewHint")}</span>
        </label>

        <label className="block">
          <span className={label}>{tr.t("privateNoteLabel")}</span>
          <textarea
            name="privateNote"
            rows={3}
            defaultValue={loaderData.initialPrivateNote}
            className="w-full resize-y rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-3 text-[15px] outline-none focus:border-accent"
          />
          <span className="mt-1 block text-[12px] text-muted">{tr.t("privateNoteHint")}</span>
        </label>

        <button
          type="submit"
          disabled={submitting || stars === 0}
          className="self-start rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
        >
          {tr.t("submitReview")}
        </button>
      </Form>
    </main>
  );
}
