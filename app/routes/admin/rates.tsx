import { Link } from "react-router";

import type { Route } from "./+types/rates";
import { requireAdmin } from "~/lib/auth.server";
import { getConfig } from "~/lib/config.server";
import { getRates, getRooms } from "~/lib/catalog.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) return { configured: false as const };

  const [rates, rooms] = await Promise.all([getRates(propertyId), getRooms(propertyId)]);
  const roomTitle = new Map(rooms.map((r) => [r.id, r.title]));
  return {
    configured: true as const,
    hasRooms: rooms.length > 0,
    rates: rates.map((r) => ({
      id: r.id,
      title: r.title,
      room: roomTitle.get(r.roomId) ?? "—",
      mealPlan: r.mealPlan,
      nightlyPrice: r.nightlyPrice,
      occupancy: { adults: r.adults, children: r.children },
      active: r.active,
    })),
  };
}

export function meta() {
  return [{ title: "Admin · Rates" }];
}

export default function AdminRates({ loaderData }: Route.ComponentProps) {
  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Rates</h1>
        <p className="text-[15px] text-secondary">
          Set <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code> to add rates.
        </p>
      </div>
    );
  }

  const { rates, hasRooms } = loaderData;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">Rates</h1>
        {hasRooms && (
          <Link
            to="/admin/rates/new"
            className="rounded-[10px] bg-accent px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep"
          >
            + New rate
          </Link>
        )}
      </div>
      <p className="mb-6 text-[14px] text-muted">
        A rate is a bookable price for a room — meal plan, nightly price, occupancy and cancellation
        policy.
      </p>

      {!hasRooms ? (
        <div className="rounded-[14px] border border-line bg-surface p-6 text-[14px] text-secondary">
          Create a <Link to="/admin/rooms/new" className="font-semibold text-accent">room</Link> first,
          then add rates to it.
        </div>
      ) : rates.length === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-6 text-[14px] text-secondary">
          No rates yet. Create your first one.
        </div>
      ) : (
        <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
          {rates.map((rate, i) => (
            <Link
              key={rate.id}
              to={`/admin/rates/${rate.id}`}
              className={`flex items-center justify-between gap-4 px-5 py-4 hover:bg-field-hover ${
                i > 0 ? "border-t border-divider" : ""
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <span className="truncate font-semibold">{rate.title}</span>
                  {!rate.active && (
                    <span className="rounded-full bg-surface-alt px-2 py-0.5 text-[11px] font-semibold text-muted-2">
                      Inactive
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[12.5px] text-muted-2">
                  {rate.room} · {rate.mealPlan || "Room only"} · {rate.occupancy.adults} adult
                  {rate.occupancy.adults === 1 ? "" : "s"}
                  {rate.occupancy.children ? `, ${rate.occupancy.children} child` : ""}
                </div>
              </div>
              <div className="flex flex-none items-center gap-4">
                <span className="font-semibold">{rate.nightlyPrice.toFixed(2)}/night</span>
                <span className="text-[13px] font-semibold text-accent">Edit →</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
