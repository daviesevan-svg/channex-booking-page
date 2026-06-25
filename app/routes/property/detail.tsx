import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { useState } from "react";
import { Link, redirect, useNavigate, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/detail";
import type { RoomWithRates } from "~/lib/channex/types";
import { useProperty } from "~/lib/booking-context";
import { getCatalogRooms } from "~/lib/catalog.server";
import { getPageText } from "~/lib/overrides.server";
import { formatMoney } from "~/lib/money";
import { addLine, parseCart, serializeCart } from "~/lib/cart";
import { langFromRequest } from "~/lib/content";
import { useT, type Translator } from "~/lib/i18n";
import { childrenAgeParam, partySize, ratePlansForParty, readOccupancy } from "~/lib/occupancy";

export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const checkin = url.searchParams.get("checkin");
  const checkout = url.searchParams.get("checkout");
  const currency = url.searchParams.get("currency") || "GBP";
  const { adults, childrenAge } = readOccupancy(url.searchParams);

  if (!checkin || !checkout) throw redirect(`/${params.channelId}`);

  const lang = langFromRequest(request);
  const rooms = await getCatalogRooms(
    params.channelId,
    {
      checkinDate: checkin,
      checkoutDate: checkout,
      currency,
      adults,
      childrenAge: childrenAgeParam(childrenAge),
    },
    { gate: true },
  );
  const room = rooms.find((r) => r.id === params.roomId);
  if (!room) throw redirect(`/${params.channelId}/rooms?${url.searchParams.toString()}`);

  const nights = Math.max(1, differenceInCalendarDays(parseISO(checkout), parseISO(checkin)));
  const text = await getPageText(params.channelId, "detail", lang);
  return { room, nights, party: partySize({ adults, childrenAge }), text, query: { checkin, checkout, currency, adults } };
}

function rateNote(plan: RoomWithRates["ratePlans"][number], tr: Translator): string {
  const parts: string[] = [];
  if (plan.mealPlan) parts.push(plan.mealPlan);
  if (plan.cancellationNote) parts.push(plan.cancellationNote);
  else if (plan.cancellationPolicy?.title)
    parts.push(tr.t("cancellationSuffix", { title: plan.cancellationPolicy.title }));
  return parts.join(" · ") || tr.t("standardRate");
}

export default function Detail({ loaderData, params }: Route.ComponentProps) {
  const { room, nights, party, text, query } = loaderData;
  const { currency } = useProperty();
  const tr = useT();
  const fmt = (d: Date, f: string) => format(d, f, { locale: tr.locale });
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const adding = navigation.state === "loading";
  const qs = searchParams.toString();

  const ratePlans = ratePlansForParty(room, party);
  const [selectedRate, setSelectedRate] = useState(ratePlans[0]?.id);
  const chosen = ratePlans.find((r) => r.id === selectedRate) ?? ratePlans[0];

  const summary = `${tr.p("night", nights)} · ${fmt(parseISO(query.checkin), "EEE d")} — ${fmt(
    parseISO(query.checkout),
    "EEE d MMM",
  )}`;

  const ratePhotos = (chosen?.images ?? []).map((url) => ({ url }));
  const galleryPhotos = [...ratePhotos, ...(room.photos ?? [])];
  const hero = galleryPhotos[0]?.url;
  const thumbs = galleryPhotos.slice(1, 3);
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
        ← {text.backLink}
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
              <h3 className="mb-4 font-serif text-[20px] font-semibold">{text.amenitiesTitle}</h3>
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
          <h3 className="mb-1 font-serif text-[21px] font-semibold">{text.rateTitle}</h3>
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
                        {formatMoney(perNight, currency)} {tr.t("perNight")}
                      </span>
                    </span>
                    <span className="mt-1 block text-[13px] leading-[1.45] text-muted">
                      {rateNote(plan, tr)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {(chosen?.description || chosen?.inclusions?.length) && (
            <div className="mb-4 rounded-[12px] bg-[#faf6ef] p-4">
              {chosen?.description && (
                <p className="text-[13.5px] leading-[1.55] text-[#5e5547]">{chosen.description}</p>
              )}
              {chosen?.inclusions?.length ? (
                <>
                  <div
                    className={`mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-2 ${
                      chosen?.description ? "mt-3" : ""
                    }`}
                  >
                    {tr.t("whatsIncluded")}
                  </div>
                  <ul className="flex flex-col gap-1.5">
                    {chosen.inclusions.map((inc, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 text-[13.5px] text-[#4a4236]"
                      >
                        <span
                          className="mt-[6px] h-[6px] w-[6px] flex-none rounded-[1px] bg-accent"
                          style={{ transform: "rotate(45deg)" }}
                        />
                        {inc}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          )}
          <div className="mb-4 flex items-baseline justify-between border-t border-divider pt-4">
            <span className="text-sm text-secondary">
              {tr.t("totalNights", { n: nights })}
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
            {adding ? "Adding…" : text.addButton}
          </button>
        </div>
      </div>
    </main>
  );
}
