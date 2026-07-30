// The card grid on the shared domain's front door.
//
// Presentation only — its data comes from loadPicker() in picker.server.ts. Split
// out of routes/home.tsx because "/" now dispatches on the hostname (picker here,
// a hotel's own home page on their custom domain), so whichever module owns that
// route needs to be able to render this without owning it.

import { Link } from "react-router";

import type { PickerCard } from "~/lib/picker.server";

const HATCH =
  "repeating-linear-gradient(135deg,#efe7da,#efe7da 11px,#e7ddcc 11px,#e7ddcc 22px)";

function Diamond({ size = 13 }: { size?: number }) {
  return (
    <span
      className="inline-block flex-none rounded-mark-lg bg-accent"
      style={{ width: size, height: size, transform: "rotate(45deg)" }}
    />
  );
}

export function PropertyPicker({ items, subtitle }: { items: PickerCard[]; subtitle: string }) {
  if (items.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-7 py-24 text-center">
        <span
          className="mx-auto mb-6 inline-block h-3.5 w-3.5 rounded-mark-lg bg-accent"
          style={{ transform: "rotate(45deg)" }}
        />
        <h1 className="font-serif text-display-3xl font-medium tracking-[-0.02em]">Roompanda</h1>
        <p className="mt-4 text-secondary">
          Open <code className="rounded bg-chip px-1.5 py-0.5">/your-property-id</code> to book, or
          create a collection / mark a property “Public” in the admin to list it here.
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
            <span className="font-serif text-title-sm font-semibold tracking-[-0.01em]">
              Roompanda
            </span>
          </div>
          <h1 className="font-serif text-[clamp(32px,6vw,46px)] font-medium leading-[1.05] tracking-[-0.02em]">
            Find your stay
          </h1>
          <p className="mt-3 text-lead leading-[1.6] text-secondary">{subtitle}</p>
        </div>

        {/* grid of cards */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((c) => (
            <Link
              key={c.href}
              to={c.href}
              className="group flex flex-col overflow-hidden rounded-panel border border-line bg-surface transition-all duration-200 hover:-translate-y-[3px] hover:border-accent hover:shadow-[0_22px_44px_-28px_rgba(70,55,35,0.5)]"
            >
              <div
                className="relative aspect-[3/2] w-full overflow-hidden"
                style={{ background: c.photo ? undefined : HATCH }}
              >
                {c.photo && (
                  <img
                    src={c.photo}
                    alt={c.name}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                  />
                )}
                <span
                  className="absolute left-3 top-3 rounded-full px-2.5 py-[5px] text-micro font-bold uppercase tracking-[0.04em]"
                  style={{ background: "rgba(255,253,250,0.92)", color: "#5a5145" }}
                >
                  {c.tag}
                </span>
              </div>
              <div className="flex flex-1 flex-col p-[22px_24px]">
                {c.meta && (
                  <div className="mb-1.5 text-label font-semibold uppercase tracking-[0.1em] text-muted">
                    {c.meta}
                  </div>
                )}
                <h3 className="font-serif text-title-xl font-semibold tracking-[-0.01em] group-hover:text-accent">
                  {c.name}
                </h3>
                {c.blurb && (
                  <p className="mt-2 line-clamp-2 text-body leading-[1.55] text-secondary">
                    {c.blurb}
                  </p>
                )}
                <span className="mt-auto pt-4 text-body font-semibold text-accent">{c.cta}</span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
