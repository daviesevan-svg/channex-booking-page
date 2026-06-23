import { Form, Link, NavLink, Outlet } from "react-router";

import type { Route } from "./+types/layout";
import { requireAdmin } from "~/lib/auth.server";
import { getConfig } from "~/lib/config.server";

export interface AdminContext {
  propertyId?: string;
}

export async function loader({ request }: Route.LoaderArgs) {
  const email = await requireAdmin(request);
  return { email, propertyId: getConfig().defaultPropertyId };
}

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  const { email, propertyId } = loaderData;
  const context: AdminContext = { propertyId };

  return (
    <div className="min-h-screen bg-page text-ink">
      <header className="border-b border-nav-border bg-surface-alt">
        <div className="mx-auto flex max-w-[960px] items-center justify-between gap-4 px-6 py-4">
          <Link to="/admin" className="flex items-center gap-3">
            <span
              className="inline-block h-3 w-3 rounded-[2px] bg-accent"
              style={{ transform: "rotate(45deg)" }}
            />
            <span className="font-serif text-[19px] font-semibold">Booking Admin</span>
          </Link>
          <div className="flex items-center gap-5 text-[13px] text-muted">
            {propertyId && (
              <Link to={`/${propertyId}`} className="hover:text-accent" target="_blank">
                View site ↗
              </Link>
            )}
            <span>{email}</span>
            <Form method="post" action="/admin/logout">
              <button type="submit" className="font-semibold hover:text-accent">
                Sign out
              </button>
            </Form>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[960px] gap-8 px-6 py-8">
        <nav className="w-44 flex-none space-y-1">
          {[
            { to: "/admin", label: "Property details", end: true },
            { to: "/admin/rooms", label: "Rooms", end: false },
          ].map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `block rounded-[10px] px-3.5 py-2.5 text-[14px] font-semibold ${
                  isActive ? "bg-surface text-ink" : "text-muted hover:text-ink"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
          <p className="mt-3 px-3.5 text-[12px] leading-[1.5] text-faint">
            More sections (theme, content) coming soon.
          </p>
        </nav>
        <main className="min-w-0 flex-1">
          <Outlet context={context} />
        </main>
      </div>
    </div>
  );
}
