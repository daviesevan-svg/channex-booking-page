import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { useState } from "react";
import { Link, redirect, useNavigate, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/detail";
import type { RoomWithRates } from "~/lib/channex/types";
import { useProperty } from "~/lib/booking-context";
import { getRoomsWithOverrides } from "~/lib/rooms.server";
import { formatMoney } from "~/lib/money";
import { addLine, parseCart, serializeCart } from "~/lib/cart";
import { childrenAgeParam, partySize, ratePlansForParty, readOccupancy } from "~/lib/occupancy";

export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const checkin = url.searchParams.get("checkin");
  const checkout = url.searchParams.get("checkout");
  const currency = url.searchParams.get("currency") || "GBP";
  const { adults, childrenAge } = readOccupancy(url.searchParams);

  if (!checkin || !checkout) throw redirect(`/${params.channelId}`);

  const rooms = await getRoomsWithOverrides(params.channelId, {
    checkinDate: checkin,
    checkoutDate: checkout,
    currency,
    adults,
    childrenAge: childrenAgeParam(childrenAge),
  });
  const room = rooms.find((r) => r.id === params.roomId);
  if (!room) throw redirect(`/${params.channelId}/rooms?${url.searchParams.toString()}`);

  const nights = Math.max(1, differenceInCalendarDays(parseISO(checkout), parseISO(checkin)));
  return { room, nights, party: partySize({ adults, childrenAge }), query: { checkin, checkout, currency, adults } };
}

function rateNote(plan: RoomWithRates["ratePlans"][number]): string {
  const parts: string[] = [];
  if (plan.mealPlan) parts.push(plan.mealPlan);
  if (plan.cancellationPolicy?.title) parts.push(`${plan.cancellationPolicy.title} cancellation`);
  return parts.join(" · ") || "Standard rate";
}

export default function Detail({ loaderData, params }: Route.ComponentProps) {
  const { room, nights, party, query } = loaderData;
  const { currency } = useProperty();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const adding = navigation.state === "loading";
  const qs = searchParams.toString();

  const ratePlans = ratePlansForParty(room, party);
  const [selectedRate, setSelectedRate] = useState(ratePlans[0]?.id);
  const chosen = ratePlans.find((r) => r.id === selectedRate) ?? ratePlans[0];

  const summary = `${nights} night${nights > 1 ? "s" : ""} · ${format(
    parseISO(query.checkin),
    "EEE d",
  )} — ${format(parseISO(query.checkout), "EEE d MMM")}`;

  const photos = room.photos ?? [];
  const hero = photos[0]?.url;
  const thumbs = photos.slice(1, 3);
  const amenities = room.facilities ?? [];

  function addToStay() {
    if (!chosen) return;
    const lines = addLine(parseCart(searchParams), { roomId: room.id, rateId: chosen.id });
    const next = new URLSearchParams(searchParams);
    next.set("sel", serializeCart(lines));
    navigate(`/${params.channelId}/rooms?${next.toString()}`);
  }

  const stripe = "repeating-linear-gradient(135deg,#efe7da,#efe7da 12px,#e7ddcc 12px,#e7ddcc 24px)";

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-7">
      <Link
        to={`/${params.channelId}/rooms?${qs}`}
        className="mb-5 inline-block text-sm font-semibold text-muted hover:text-accent"
      >
        ← All rooms
      </Link>

      {/* gallery */}
      <div className="mb-7 flex h-[380px] gap-3">
        <div className="flex-[2] overflow-hidden rounded-[16px]" style={{ background: stripe }}>
          {hero && <img src={hero} alt={room.title} className="h-full w-full object-cover" />}
        </div>
        <div className="flex flex-1 flex-col gap-3">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="flex-1 overflow-hidden rounded-[16px]"
              style={{ background: stripe }}
            >
              {thumbs[i] && (
                <img src={thumbs[i].url} alt="" className="h-full w-full object-cover" />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-10">
        <div className="min-w-[320px] flex-[1.6]">
          <h1 className="mb-2 font-serif text-[40px] font-medium tracking-[-0.02em]">
            {room.title}
          </h1>
          {room.description && (
            <p className="mb-7 max-w-[560px] text-[17px] leading-[1.65] text-[#5e5547]">
              {room.description}
            </p>
          )}
          {amenities.length > 0 && (
            <>
              <h3 className="mb-4 font-serif text-[20px] font-semibold">In this room</h3>
              <div className="grid max-w-[520px] grid-cols-1 gap-x-7 gap-y-3 sm:grid-cols-2">
                {amenities.map((a) => (
                  <div key={a} className="flex items-center gap-3 text-[15px] text-[#4a4236]">
                    <span
                      className="h-[7px] w-[7px] flex-none rounded-[1px] bg-accent"
                      style={{ transform: "rotate(45deg)" }}
                    />
                    {a}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* rate card */}
        <div
          className="sticky top-24 min-w-[320px] flex-1 rounded-[18px] border border-line bg-surface p-6"
          style={{ boxShadow: "var(--shadow-sticky)" }}
        >
          <h3 className="mb-1 font-serif text-[21px] font-semibold">Choose your rate</h3>
          <div className="mb-[18px] text-[13.5px] text-muted-2">{summary}</div>
          <div className="mb-5 flex flex-col gap-2.5">
            {ratePlans.map((plan) => {
              const active = plan.id === chosen?.id;
              const perNight = Number(plan.totalPrice) / nights;
              return (
                <button
                  key={plan.id}
                  type="button"
                  onClick={() => setSelectedRate(plan.id)}
                  className="flex items-start gap-3 rounded-[12px] border-[1.5px] p-4 text-left transition-colors"
                  style={{
                    borderColor: active ? "var(--accent)" : "#e8e0d5",
                    background: active ? "var(--accent-soft)" : "#fff",
                  }}
                >
                  <span
                    className="mt-0.5 h-[18px] w-[18px] flex-none rounded-full border-2"
                    style={{
                      borderColor: active ? "var(--accent)" : "#cfc4b2",
                      background: active ? "var(--accent)" : "transparent",
                    }}
                  />
                  <span className="flex-1">
                    <span className="flex items-baseline justify-between gap-2.5">
                      <span className="text-[15.5px] font-semibold">{plan.title}</span>
                      <span className="whitespace-nowrap text-[15.5px] font-semibold">
                        {formatMoney(perNight, currency)} / night
                      </span>
                    </span>
                    <span className="mt-1 block text-[13px] leading-[1.45] text-muted">
                      {rateNote(plan)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mb-4 flex items-baseline justify-between border-t border-divider pt-4">
            <span className="text-sm text-secondary">
              Total · {nights} night{nights > 1 ? "s" : ""}
            </span>
            <span className="font-serif text-[28px] font-semibold">
              {chosen ? formatMoney(chosen.totalPrice, currency) : "—"}
            </span>
          </div>
          <button
            type="button"
            onClick={addToStay}
            disabled={adding}
            className="w-full rounded-[12px] bg-accent py-[15px] text-[16px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:opacity-70"
          >
            {adding ? "Adding…" : "Add to your stay"}
          </button>
        </div>
      </div>
    </main>
  );
}
