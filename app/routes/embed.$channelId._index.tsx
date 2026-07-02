import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import type { Route } from "./+types/embed.$channelId._index";
import { CalendarPopover } from "~/components/calendar-popover";
import { GuestSelector } from "~/components/guest-selector";
import { DEFAULT_SEARCH, langFromRequest } from "~/lib/content";
import { useT } from "~/lib/i18n";
import type { Occupancy } from "~/lib/occupancy";
import { readOccupancy, writeOccupancy } from "~/lib/occupancy";
import { getSearchContent } from "~/lib/overrides.server";
import { resolvePropertyId } from "~/lib/properties.server";
import { useDateRange } from "~/lib/use-date-range";

// Localized CTA label (honours the hotel's edited "Search" button + language).
// No ARI read — just page content (cheap KV), keeping the widget cacheable.
export async function loader({ params, request }: Route.LoaderArgs) {
  // :channelId may be a slug — resolve for the content lookup, but keep the
  // original segment as `channelId` so the deep-link stays on the slug.
  const pid = await resolvePropertyId(params.channelId);
  const content = await getSearchContent(pid, langFromRequest(request));
  return { channelId: params.channelId, searchButton: content.searchButton || DEFAULT_SEARCH.searchButton };
}

export function headers() {
  return { "Cache-Control": "public, max-age=300" };
}

// The embeddable date-picker. "Dumb" by design: no ARI/closed-dates fetch
// (closedDates=null → only past dates disabled). On submit it hands off to the
// hosted booking flow, and it reports its height so the host iframe can resize.
export default function EmbedPicker({ loaderData }: Route.ComponentProps) {
  const { channelId, searchButton } = loaderData;
  const tr = useT();
  const [searchParams] = useSearchParams();

  const dates = useDateRange({
    closedDates: null, // dumb widget — availability is enforced on the results page
    initialCheckin: searchParams.get("checkin") ?? undefined,
    initialCheckout: searchParams.get("checkout") ?? undefined,
    tr,
  });
  const [showCal, setShowCal] = useState(false);
  const [occupancy, setOccupancy] = useState<Occupancy>(() => readOccupancy(searchParams));
  const rootRef = useRef<HTMLDivElement>(null);

  // Report height to the host page so embed.js can size the iframe to fit
  // (initial + whenever the calendar/guest popovers open and change layout).
  useEffect(() => {
    if (typeof window === "undefined" || window.parent === window) return;
    const post = () =>
      window.parent.postMessage(
        { type: "roompanda:height", height: Math.ceil(document.documentElement.scrollHeight) },
        "*",
      );
    post();
    const ro = new ResizeObserver(post);
    if (rootRef.current) ro.observe(rootRef.current);
    window.addEventListener("resize", post);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", post);
    };
  }, []);

  function search() {
    if (!dates.checkinIso || !dates.checkoutIso) {
      setShowCal(true);
      return;
    }
    // Currency is intentionally omitted — the results page derives it from the
    // property settings (client currency isn't trusted anywhere in the flow).
    const qs = writeOccupancy(
      new URLSearchParams({ checkin: dates.checkinIso, checkout: dates.checkoutIso }),
      occupancy,
    );
    const url = `${window.location.origin}/${channelId}/rooms?${qs.toString()}`;
    // Navigate the host's top window into the booking flow (embed.js relays it,
    // origin-checked). If not framed (direct view / admin preview), go directly.
    if (window.parent !== window) {
      window.parent.postMessage({ type: "roompanda:navigate", url }, "*");
    } else {
      window.location.href = url;
    }
  }

  const dateBtn =
    "min-w-[130px] flex-1 cursor-pointer rounded-[12px] px-4 py-3 text-left transition-colors hover:bg-field-hover";

  return (
    <div ref={rootRef} className="p-3">
      <div
        className="flex flex-wrap items-stretch gap-1.5 rounded-[18px] border border-line bg-surface p-2.5"
        style={{ boxShadow: "var(--shadow-card)" }}
      >
        <div className="relative flex min-w-[260px] flex-[2] flex-wrap items-stretch gap-1.5">
          <button type="button" onClick={() => setShowCal(true)} className={dateBtn}>
            <div className="field-label mb-1">{tr.t("checkIn")}</div>
            <div className="text-[16px] font-semibold" style={{ color: dates.checkin ? "#2a2521" : "#b6ab9d" }}>
              {dates.checkinLabel}
            </div>
          </button>
          <div className="my-2 w-px bg-line" />
          <button type="button" onClick={() => setShowCal(true)} className={dateBtn}>
            <div className="field-label mb-1">{tr.t("checkOut")}</div>
            <div className="text-[16px] font-semibold" style={{ color: dates.checkout ? "#2a2521" : "#b6ab9d" }}>
              {dates.checkoutLabel}
            </div>
          </button>
          {showCal && <CalendarPopover state={dates} onClose={() => setShowCal(false)} />}
        </div>
        <div className="my-2 w-px bg-line" />
        <GuestSelector value={occupancy} onChange={setOccupancy} />
        <button
          type="button"
          onClick={search}
          className="min-h-14 flex-none cursor-pointer rounded-[12px] bg-accent px-7 text-[15px] font-semibold text-white transition-colors hover:bg-accent-deep"
        >
          {searchButton}
        </button>
      </div>
    </div>
  );
}
