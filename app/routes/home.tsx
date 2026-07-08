import { Link, redirect } from "react-router";

import type { Route } from "./+types/home";
import { getConfig } from "~/lib/config.server";
import { getProperty, getPublicProperties } from "~/lib/properties.server";
import { getOverrides, getSettings } from "~/lib/overrides.server";

const HATCH =
  "repeating-linear-gradient(135deg,#efe7da,#efe7da 11px,#e7ddcc 11px,#e7ddcc 22px)";

export async function loader() {
  const properties = await getPublicProperties();

  // No public properties: fall back to the configured default property (single-
  // hotel deploys), but only if it's registered — else the property route 404s.
  // Otherwise show the setup hint.
  if (properties.length === 0) {
    const { defaultPropertyId } = getConfig();
    if (defaultPropertyId && (await getProperty(defaultPropertyId))) {
      throw redirect(`/${defaultPropertyId}`);
    }
    return { properties: [] as PropertyCard[] };
  }

  // Otherwise showcase every public property (no auto-redirect, even for one) —
  // this is the directory of hotels bookable direct through Roompanda.
  const cards = await Promise.all(
    properties.map(async (p): Promise<PropertyCard> => {
      const [settings, ov] = await Promise.all([getSettings(p.id), getOverrides(p.id)]);
      const area = [settings.addressCity, settings.addressRegion].filter(Boolean).join(", ");
      return {
        urlSeg: p.slug || p.id,
        name: ov.hotelName || p.name,
        area: area || settings.addressCountry || "",
        type: ov.propertyType || (settings.singleUnit ? "Apartment" : "Hotel"),
        photo: settings.coverImage || null,
        description: ov.description || "",
      };
    }),
  );
  return { properties: cards };
}

interface PropertyCard {
  urlSeg: string;
  name: string;
  area: string;
  type: string;
  photo: string | null;
  description: string;
}

export function meta() {
  return [
    { title: "Book direct — Roompanda" },
    { name: "description", content: "Browse and book hotels and apartments directly, commission-free." },
  ];
}

function Diamond({ size = 13 }: { size?: number }) {
  return (
    <span
      className="inline-block flex-none rounded-[2px] bg-accent"
      style={{ width: size, height: size, transform: "rotate(45deg)" }}
    />
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const properties = loaderData?.properties ?? [];

  if (properties.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-7 py-24 text-center">
        <span className="mx-auto mb-6 inline-block h-3.5 w-3.5 rounded-[2px] bg-accent" style={{ transform: "rotate(45deg)" }} />
        <h1 className="font-serif text-[40px] font-medium tracking-[-0.02em]">Roompanda</h1>
        <p className="mt-4 text-secondary">
          Open <code className="rounded bg-chip px-1.5 py-0.5">/your-property-id</code> to book, or
          mark a property “Public” in the admin to list it here.
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-page">
      <div className="mx-auto max-w-[1160px] px-[clamp(16px,4vw,32px)] py-[clamp(40px,7vw,80px)]">
        {/* hero */}
        <div className="mb-[clamp(28px,5vw,52px)] max-w-[640px]">
          <div className="mb-5 flex items-center gap-3">
            <Diamond />
            <span className="font-serif text-[19px] font-semibold tracking-[-0.01em]">Roompanda</span>
          </div>
          <h1 className="font-serif text-[clamp(32px,6vw,46px)] font-medium leading-[1.05] tracking-[-0.02em]">
            Find your stay
          </h1>
          <p className="mt-3 text-[16px] leading-[1.6] text-secondary">
            {properties.length === 1
              ? "Check availability and book direct — no booking fees."
              : `Browse ${properties.length} places to stay and book direct — no booking fees.`}
          </p>
        </div>

        {/* grid of property cards */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {properties.map((p) => (
            <Link
              key={p.urlSeg}
              to={`/${p.urlSeg}`}
              className="group flex flex-col overflow-hidden rounded-[16px] border border-line bg-surface transition-all duration-200 hover:-translate-y-[3px] hover:border-accent hover:shadow-[0_22px_44px_-28px_rgba(70,55,35,0.5)]"
            >
              <div
                className="relative aspect-[3/2] w-full overflow-hidden"
                style={{ background: p.photo ? undefined : HATCH }}
              >
                {p.photo && (
                  <img
                    src={p.photo}
                    alt={p.name}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                  />
                )}
                <span
                  className="absolute left-3 top-3 rounded-full px-2.5 py-[5px] text-[11px] font-bold uppercase tracking-[0.04em]"
                  style={{ background: "rgba(255,253,250,0.92)", color: "#5a5145" }}
                >
                  {p.type}
                </span>
              </div>
              <div className="flex flex-1 flex-col p-[22px_24px]">
                {p.area && (
                  <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">
                    {p.area}
                  </div>
                )}
                <h3 className="font-serif text-[22px] font-semibold tracking-[-0.01em] group-hover:text-accent">
                  {p.name}
                </h3>
                {p.description && (
                  <p className="mt-2 line-clamp-2 text-[14px] leading-[1.55] text-secondary">
                    {p.description}
                  </p>
                )}
                <span className="mt-auto pt-4 text-[14.5px] font-semibold text-accent">
                  Check availability →
                </span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
