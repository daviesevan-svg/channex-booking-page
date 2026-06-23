import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { Link } from "react-router";

import type { Route } from "./+types/confirmation";
import { useProperty } from "~/lib/booking-context";
import { cartCoverage, parseCart, resolveCart } from "~/lib/cart";
import { formatMoney } from "~/lib/money";
import { langFromRequest } from "~/lib/content";
import { occupancyLabel, readOccupancy } from "~/lib/occupancy";
import { getPageText } from "~/lib/overrides.server";
import { getRoomsWithOverrides } from "~/lib/rooms.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const checkin = url.searchParams.get("checkin");
  const checkout = url.searchParams.get("checkout");
  const currency = url.searchParams.get("currency") || "GBP";
  const occ = readOccupancy(url.searchParams);
  const simulated = url.searchParams.get("sim") === "1";
  const lang = langFromRequest(request);

  let datesStr = "";
  let rooms: { title: string; rate: string }[] = [];
  let totalStr = "";

  if (checkin && checkout) {
    const nights = Math.max(1, differenceInCalendarDays(parseISO(checkout), parseISO(checkin)));
    datesStr = `${format(parseISO(checkin), "EEE d")} — ${format(
      parseISO(checkout),
      "EEE d MMM",
    )} · ${nights} night${nights > 1 ? "s" : ""}`;

    const apiRooms = await getRoomsWithOverrides(
      params.channelId,
      { checkinDate: checkin, checkoutDate: checkout, currency, adults: occ.adults },
      lang,
    );
    const lines = resolveCart(parseCart(url.searchParams), apiRooms);
    rooms = lines.map((l) => ({ title: l.roomTitle, rate: l.rateTitle }));
    if (lines.length) totalStr = formatMoney(cartCoverage(lines).total, currency);
  }

  return {
    reference: params.ref,
    simulated,
    rooms,
    totalStr,
    datesStr,
    guests: occupancyLabel(occ.adults, occ.childrenAge),
    text: await getPageText(params.channelId, "confirmation", lang),
  };
}

export default function Confirmation({ loaderData, params }: Route.ComponentProps) {
  const { reference, simulated, rooms, totalStr, datesStr, guests, text } = loaderData;
  const { hotelName } = useProperty();
  const stripe = "repeating-linear-gradient(135deg,#efe7da,#efe7da 9px,#e7ddcc 9px,#e7ddcc 18px)";

  return (
    <main className="mx-auto max-w-[660px] px-7 pb-20 pt-16 text-center">
      {simulated && (
        <div className="mb-6 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3 text-[13px] text-muted">
          Demo mode — no live reservation was created. Set <code>ALLOW_LIVE_BOOKING=true</code> to
          submit real bookings.
        </div>
      )}
      <div
        className="mx-auto mb-7 flex h-[72px] w-[72px] items-center justify-center rounded-full"
        style={{ background: "var(--accent-soft-strong)" }}
      >
        <span
          className="block h-[13px] w-6"
          style={{
            borderLeft: "3px solid var(--accent)",
            borderBottom: "3px solid var(--accent)",
            transform: "rotate(-45deg)",
            marginTop: -5,
          }}
        />
      </div>
      <h1 className="mb-3 font-serif text-[44px] font-medium tracking-[-0.02em]">{text.heading}</h1>
      <p className="mb-2 text-[18px] leading-[1.6] text-secondary">
        {text.subtitle.replaceAll("{hotel}", hotelName)}
      </p>
      <div
        className="mb-9 inline-block rounded-full px-[18px] py-2 text-sm font-semibold tracking-[0.04em] text-accent"
        style={{ background: "var(--accent-soft)" }}
      >
        Confirmation {reference}
      </div>

      <div
        className="rounded-[18px] border border-line bg-surface p-[26px] text-left"
        style={{ boxShadow: "var(--shadow-confirm)" }}
      >
        <div className="flex flex-col gap-4 border-b border-divider pb-5">
          {rooms.map((r, i) => (
            <div key={i} className="flex items-center gap-[18px]">
              <div className="h-16 w-[84px] flex-none rounded-[12px]" style={{ background: stripe }} />
              <div>
                <div className="font-serif text-[19px] font-semibold">{r.title}</div>
                <div className="mt-[3px] text-[13.5px] text-muted-2">{r.rate}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 flex flex-col gap-3 text-[15px]">
          <div className="flex justify-between">
            <span className="text-secondary">Dates</span>
            <span className="font-semibold">{datesStr}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-secondary">Guests</span>
            <span className="font-semibold">{guests}</span>
          </div>
          {totalStr && (
            <div className="flex items-baseline justify-between border-t border-divider pt-3">
              <span className="text-secondary">Total</span>
              <span className="font-serif text-[24px] font-semibold">{totalStr}</span>
            </div>
          )}
        </div>
      </div>

      <Link
        to={`/${params.channelId}`}
        className="mt-7 inline-block rounded-[12px] border border-line-alt bg-surface-alt px-7 py-3.5 text-[15px] font-semibold text-[#5a5145] hover:border-accent hover:text-accent"
      >
        {text.newBooking}
      </Link>
    </main>
  );
}
