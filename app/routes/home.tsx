import { Link, redirect } from "react-router";

import type { Route } from "./+types/home";
import { getConfig } from "~/lib/config.server";
import { getPublicProperties } from "~/lib/properties.server";

export async function loader() {
  const properties = await getPublicProperties();

  // One public property → skip the picker and go straight to it.
  if (properties.length === 1) {
    throw redirect(`/${properties[0].slug || properties[0].id}`);
  }
  // Several → show the picker (rendered below). Prefer the shortcode in the link.
  if (properties.length > 1) {
    return { properties: properties.map((p) => ({ id: p.id, slug: p.slug, name: p.name })) };
  }

  // None marked public: fall back to the configured default property, or the
  // setup hint if there isn't one.
  const { defaultPropertyId } = getConfig();
  if (defaultPropertyId) {
    throw redirect(`/${defaultPropertyId}`);
  }
  return { properties: [] as { id: string; slug?: string; name: string }[] };
}

export function meta() {
  return [{ title: "Channex Booking" }];
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const properties = loaderData?.properties ?? [];

  if (properties.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-7 py-24 text-center">
        <span
          className="mx-auto mb-6 inline-block h-3.5 w-3.5 rounded-[2px] bg-accent"
          style={{ transform: "rotate(45deg)" }}
        />
        <h1 className="font-serif text-[40px] font-medium tracking-[-0.02em]">
          Channex Booking Engine
        </h1>
        <p className="mt-4 text-secondary">
          Open <code className="rounded bg-chip px-1.5 py-0.5">/your-property-id</code> to book, or
          mark a property “Public” in the admin to list it here.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-7 py-20">
      <div className="mb-10 text-center">
        <span
          className="mx-auto mb-6 inline-block h-3.5 w-3.5 rounded-[2px] bg-accent"
          style={{ transform: "rotate(45deg)" }}
        />
        <h1 className="font-serif text-[34px] font-medium tracking-[-0.02em]">
          Choose where to stay
        </h1>
        <p className="mt-3 text-secondary">Select a property to check availability and book.</p>
      </div>

      <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
        {properties.map((p, i) => (
          <Link
            key={p.id}
            to={`/${p.slug || p.id}`}
            className={`flex items-center justify-between gap-3 px-6 py-5 transition-colors hover:bg-chip ${
              i > 0 ? "border-t border-divider" : ""
            }`}
          >
            <span className="font-serif text-[19px] font-medium">{p.name}</span>
            <span className="text-[15px] font-semibold text-accent">Book →</span>
          </Link>
        ))}
      </div>
    </main>
  );
}
