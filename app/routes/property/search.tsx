import { useState } from "react";
import { useNavigate, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/search";
import { CalendarPopover } from "~/components/calendar-popover";
import { GuestSelector } from "~/components/guest-selector";
import { useProperty } from "~/lib/booking-context";
import { getChannexClient } from "~/lib/config.server";
import type { Occupancy } from "~/lib/occupancy";
import { readOccupancy, writeOccupancy } from "~/lib/occupancy";
import { useDateRange } from "~/lib/use-date-range";

export async function loader({ params }: Route.LoaderArgs) {
  const client = getChannexClient();
  const closedDates = await client.getClosedDates(params.channelId).catch(() => null);
  return { closedDates };
}

const HIGHLIGHTS = [
  { title: "Free cancellation", desc: "On all flexible rates, up to 24h before arrival." },
  { title: "Best rate, guaranteed", desc: "Lower price elsewhere? We'll match it." },
  { title: "No booking fees", desc: "The price you see is the price you pay." },
];

function Diamond({ size = 9, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`inline-block flex-none rounded-[1px] bg-accent ${className}`}
      style={{ width: size, height: size, transform: "rotate(45deg)" }}
    />
  );
}

export default function Search({ loaderData, params }: Route.ComponentProps) {
  const { closedDates } = loaderData;
  const { property, currency, hotelName } = useProperty();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const dates = useDateRange({
    closedDates,
    initialCheckin: searchParams.get("checkin") ?? undefined,
    initialCheckout: searchParams.get("checkout") ?? undefined,
  });
  const [showCal, setShowCal] = useState(false);
  const [occupancy, setOccupancy] = useState<Occupancy>(() => readOccupancy(searchParams));
  const navigation = useNavigation();
  const searching = navigation.state === "loading";

  const eyebrow = (property.address?.split(",")[1] ?? hotelName).trim();
  const heroPhoto = property.photos?.[0]?.url;

  function searchRooms() {
    if (!dates.checkinIso || !dates.checkoutIso) {
      setShowCal(true);
      return;
    }
    const qs = writeOccupancy(
      new URLSearchParams({
        checkin: dates.checkinIso,
        checkout: dates.checkoutIso,
        currency,
      }),
      occupancy,
    );
    navigate(`/${params.channelId}/rooms?${qs.toString()}`);
  }

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-16">
      <div className="max-w-[680px]">
        <div className="eyebrow mb-[18px]">{eyebrow}</div>
        <h1 className="mb-[18px] font-serif text-[56px] font-medium leading-[1.05] tracking-[-0.02em]">
          Reserve your stay
        </h1>
        <p className="mb-9 max-w-[560px] text-[18px] leading-[1.6] text-secondary">
          Book direct for our best available rates, free cancellation on flexible
          bookings, and absolutely no booking fees — every time.
        </p>
      </div>

      {/* search card */}
      <div className="relative max-w-[920px]">
        <div
          className="flex flex-wrap items-stretch gap-1.5 rounded-[18px] border border-line bg-surface p-3.5"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          <button
            type="button"
            onClick={() => setShowCal(true)}
            className="min-w-[150px] flex-1 cursor-pointer rounded-[12px] px-[18px] py-3.5 text-left transition-colors hover:bg-field-hover"
          >
            <div className="field-label mb-1.5">Check-in</div>
            <div
              className="text-[17px] font-semibold"
              style={{ color: dates.checkin ? "#2a2521" : "#b6ab9d" }}
            >
              {dates.checkinLabel}
            </div>
          </button>
          <div className="my-2 w-px bg-line" />
          <button
            type="button"
            onClick={() => setShowCal(true)}
            className="min-w-[150px] flex-1 cursor-pointer rounded-[12px] px-[18px] py-3.5 text-left transition-colors hover:bg-field-hover"
          >
            <div className="field-label mb-1.5">Check-out</div>
            <div
              className="text-[17px] font-semibold"
              style={{ color: dates.checkout ? "#2a2521" : "#b6ab9d" }}
            >
              {dates.checkoutLabel}
            </div>
          </button>
          <div className="my-2 w-px bg-line" />
          <GuestSelector value={occupancy} onChange={setOccupancy} />
          <button
            type="button"
            onClick={searchRooms}
            disabled={searching}
            className="min-h-16 flex-none cursor-pointer rounded-[12px] bg-accent px-[34px] text-[16px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:opacity-70"
          >
            {searching ? "Searching…" : "Search rooms"}
          </button>
        </div>

        {showCal && <CalendarPopover state={dates} onClose={() => setShowCal(false)} />}
      </div>

      <div className="mt-3.5 flex cursor-pointer items-center gap-1.5 text-sm text-muted">
        <span className="text-[18px] leading-none text-accent">+</span> Add a promo or
        corporate code
      </div>

      {/* highlights */}
      <div className="mt-12 grid max-w-[920px] grid-cols-1 gap-[18px] sm:grid-cols-3">
        {HIGHLIGHTS.map((h) => (
          <div key={h.title} className="flex items-start gap-3.5">
            <Diamond className="mt-1.5" />
            <div>
              <div className="mb-0.5 text-[15px] font-semibold">{h.title}</div>
              <div className="text-sm leading-[1.5] text-muted">{h.desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ambiance image */}
      <div className="relative mt-12 h-[300px] overflow-hidden rounded-[18px]">
        {heroPhoto ? (
          <img src={heroPhoto} alt={hotelName} className="h-full w-full object-cover" />
        ) : (
          <div
            className="h-full w-full"
            style={{
              background:
                "repeating-linear-gradient(135deg,#efe7da,#efe7da 13px,#e7ddcc 13px,#e7ddcc 26px)",
            }}
          />
        )}
      </div>
    </main>
  );
}
