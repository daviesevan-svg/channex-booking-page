import { Link } from "react-router";

import type { Route } from "./+types/rooms";
import { requireAdmin } from "~/lib/auth.server";
import { getConfig } from "~/lib/config.server";
import { getRates, getRooms } from "~/lib/catalog.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) return { configured: false as const };

  const [rooms, rates] = await Promise.all([getRooms(propertyId), getRates(propertyId)]);
  return {
    configured: true as const,
    rooms: rooms.map((r) => ({
      id: r.id,
      title: r.title,
      maxAdults: r.maxAdults,
      maxGuests: r.maxGuests,
      images: r.images.length,
      rateCount: rates.filter((rt) => rt.roomId === r.id).length,
    })),
  };
}

export function meta() {
  return [{ title: "Admin · Rooms" }];
}

export default function AdminRooms({ loaderData }: Route.ComponentProps) {
  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Rooms</h1>
        <p className="text-[15px] text-secondary">
          Set <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code> to add rooms.
        </p>
      </div>
    );
  }

  const { rooms } = loaderData;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">Rooms</h1>
        <Link
          to="/admin/rooms/new"
          className="rounded-[10px] bg-accent px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep"
        >
          + New room
        </Link>
      </div>
      <p className="mb-6 text-[14px] text-muted">
        The room types guests can book. Add photos, capacity and a description; attach rates on the
        Rates page.
      </p>

      {rooms.length === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-6 text-[14px] text-secondary">
          No rooms yet. Create your first one.
        </div>
      ) : (
        <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
          {rooms.map((room, i) => (
            <Link
              key={room.id}
              to={`/admin/rooms/${room.id}`}
              className={`flex items-center justify-between gap-4 px-5 py-4 hover:bg-field-hover ${
                i > 0 ? "border-t border-divider" : ""
              }`}
            >
              <div className="min-w-0">
                <div className="truncate font-semibold">{room.title}</div>
                <div className="mt-0.5 text-[12.5px] text-muted-2">
                  Sleeps {room.maxGuests} · up to {room.maxAdults} adult
                  {room.maxAdults === 1 ? "" : "s"} · {room.images} photo
                  {room.images === 1 ? "" : "s"} · {room.rateCount} rate
                  {room.rateCount === 1 ? "" : "s"}
                </div>
              </div>
              <span className="flex-none text-[13px] font-semibold text-accent">Edit →</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
