// Location section with a click-to-load map.
//
// A Google Maps JS load is billed per map, so a map that draws itself on page
// view charges us for every visitor including the ones who never look at it.
// This shows a GENERIC drawn map — inline SVG, not a Static Maps image of the
// real location, which would be billable too — and only fetches Google when
// someone actually asks for it.
//
// Most guests just want the address and directions, and both of those are free:
// the address is already in our own data, and a maps.google.com directions link
// is an ordinary hyperlink.

import { useState } from "react";

import { RichText } from "~/components/rich-text";
import { loadGoogleMaps } from "~/lib/google-maps-client";
import type { Translator } from "~/lib/i18n";

/** A plausible street map, drawn rather than fetched. Deliberately not the
 *  property's real surroundings — it's a placeholder for a button, and every
 *  way of showing the true location before the click costs money. */
function MapPlaceholder() {
  return (
    <svg
      viewBox="0 0 800 340"
      preserveAspectRatio="xMidYMid slice"
      className="h-full w-full"
      aria-hidden
    >
      <rect width="800" height="340" fill="#eceae6" />
      {/* blocks */}
      <g fill="#e3e0da">
        <rect x="40" y="30" width="150" height="90" rx="4" />
        <rect x="40" y="150" width="110" height="70" rx="4" />
        <rect x="40" y="248" width="170" height="70" rx="4" />
        <rect x="330" y="34" width="130" height="80" rx="4" />
        <rect x="345" y="150" width="120" height="60" rx="4" />
        <rect x="300" y="250" width="140" height="70" rx="4" />
        <rect x="560" y="40" width="120" height="100" rx="4" />
        <rect x="600" y="180" width="150" height="60" rx="4" />
        <rect x="540" y="262" width="120" height="56" rx="4" />
      </g>
      {/* a park, for a bit of life */}
      <path d="M232 158 h72 v58 h-72 z" fill="#dbe3d6" />
      {/* roads */}
      <g stroke="#fbfaf8" fill="none" strokeLinecap="round">
        <path d="M-20 136 H820" strokeWidth="22" />
        <path d="M-20 236 H820" strokeWidth="16" />
        <path d="M215 -20 V360" strokeWidth="20" />
        <path d="M500 -20 V360" strokeWidth="14" />
        <path d="M690 -20 L560 360" strokeWidth="13" />
        <path d="M-20 40 L300 -10" strokeWidth="10" />
      </g>
      {/* roundabouts */}
      <g fill="none" stroke="#fbfaf8" strokeWidth="14">
        <circle cx="215" cy="136" r="26" />
        <circle cx="500" cy="236" r="19" />
      </g>
      <g fill="#eceae6">
        <circle cx="215" cy="136" r="14" />
        <circle cx="500" cy="236" r="9" />
      </g>
    </svg>
  );
}

export function MapSection({
  heading,
  directions,
  address,
  lat,
  lng,
  zoom,
  mapKey,
  hotelName,
  tr,
}: {
  heading: string;
  directions?: string;
  address?: string;
  lat: number;
  lng: number;
  zoom: number;
  /** Empty when no key is configured — then there's nothing to click through to. */
  mapKey: string;
  hotelName: string;
  tr: Translator;
}) {
  const [show, setShow] = useState(false);
  const [failed, setFailed] = useState(false);

  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

  return (
    <div className="mt-12">
      <h2 className="mb-2 font-serif text-title-3xl font-semibold">{heading}</h2>
      {(address || directions) && (
        <div className="mb-5 max-w-[620px] text-body-lg leading-[1.6] text-muted">
          {address && <p className="whitespace-pre-line">{address}</p>}
          {directions && (
            <div className="mt-2">
              <RichText text={directions} />
            </div>
          )}
        </div>
      )}

      <div className="relative h-[340px] overflow-hidden rounded-panel-lg border border-line bg-surface-alt">
        {show && !failed ? (
          <LiveMap
            lat={lat}
            lng={lng}
            zoom={zoom}
            mapKey={mapKey}
            hotelName={hotelName}
            onFail={() => setFailed(true)}
          />
        ) : (
          <>
            <MapPlaceholder />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5">
              {mapKey && !failed && (
                <button
                  type="button"
                  onClick={() => setShow(true)}
                  className="cursor-pointer rounded-control bg-accent px-6 py-3 text-body-lg font-semibold text-white shadow-sm hover:bg-accent-deep"
                >
                  {tr.t("showMap")}
                </button>
              )}
              {failed && (
                <span className="rounded-control bg-surface px-4 py-2 text-caption font-medium text-secondary">
                  {tr.t("mapUnavailable")}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Outside the branch on purpose. Opening the map used to remove this, and
          a key that Google rejects leaves a blank grey box — so the one link
          that always works has to survive both. It costs nothing either way. */}
      <a
        href={directionsUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-3 inline-block text-body font-semibold text-accent hover:underline"
      >
        {tr.t("getDirections")} ↗
      </a>
    </div>
  );
}

function LiveMap({
  lat,
  lng,
  zoom,
  mapKey,
  hotelName,
  onFail,
}: {
  lat: number;
  lng: number;
  zoom: number;
  mapKey: string;
  hotelName: string;
  onFail: () => void;
}) {
  // A callback ref, not useEffect+useRef: the div is only mounted once the
  // guest clicks, and this way the map is built the moment it exists.
  const attach = (el: HTMLDivElement | null) => {
    if (!el || el.dataset.mapReady === "1") return;
    el.dataset.mapReady = "1";
    // Google resolves importLibrary even when the key is rejected, then renders
    // nothing — this global is the only signal that it failed. Without it a bad
    // or referrer-blocked key shows a blank grey box for ever.
    (window as unknown as { gm_authFailure?: () => void }).gm_authFailure = () => {
      delete el.dataset.mapReady;
      onFail();
    };
    loadGoogleMaps(mapKey)
      .then(() => {
        const g = (window as unknown as { google: any }).google;
        const map = new g.maps.Map(el, {
          center: { lat, lng },
          zoom,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          clickableIcons: false,
          gestureHandling: "cooperative",
        });
        new g.maps.Marker({ position: { lat, lng }, map, title: hotelName });
      })
      .catch(() => {
        delete el.dataset.mapReady;
        onFail();
      });
  };
  return <div ref={attach} className="h-full w-full" />;
}
