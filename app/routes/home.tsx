import { redirect } from "react-router";

import type { Route } from "./+types/home";
import { getConfig } from "~/lib/config.server";

export async function loader() {
  const { defaultPropertyId } = getConfig();
  if (defaultPropertyId) {
    throw redirect(`/${defaultPropertyId}`);
  }
  return null;
}

export function meta() {
  return [{ title: "Channex Booking" }];
}

export default function Home() {
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
        set <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code> to route here
        automatically.
      </p>
    </main>
  );
}
