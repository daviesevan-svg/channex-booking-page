import { Link } from "react-router";

import type { Route } from "./+types/rooms";
import { requireAdmin } from "~/lib/auth.server";
import { getChannexClient, getConfig } from "~/lib/config.server";
import { getRoomOverrides } from "~/lib/overrides.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) return { configured: false as const };

  // Rooms without dates = the full room-type list (id + title), incl. sold-out ones.
  const rooms = await getChannexClient().getRooms(propertyId).catch(() => []);
  const overrides = await getRoomOverrides(propertyId);

  return {
    configured: true as const,
    rooms: rooms.map((r) => ({
      id: r.id,
      channexTitle: r.title,
      name: overrides[r.id]?.name,
      customised: Boolean(overrides[r.id] && Object.keys(overrides[r.id]).length),
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
          Set <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code> to map
          rooms.
        </p>
      </div>
    );
  }

  const { rooms } = loaderData;

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">Rooms</h1>
      <p className="mb-6 text-[14px] text-muted">
        {rooms.length} room type{rooms.length === 1 ? "" : "s"} from Channex. Add your own name,
        description and photos to each.
      </p>

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
              <div className="flex items-center gap-2.5">
                <span className="truncate font-semibold">{room.name || room.channexTitle}</span>
                {room.customised && (
                  <span className="rounded-full bg-[#e8f0e6] px-2 py-0.5 text-[11px] font-semibold text-[#3f7a52]">
                    Customised
                  </span>
                )}
              </div>
              {room.name && room.name !== room.channexTitle && (
                <div className="text-[12.5px] text-muted-2">Channex: {room.channexTitle}</div>
              )}
              <div className="mt-0.5 font-mono text-[11px] text-faint">{room.id}</div>
            </div>
            <span className="flex-none text-[13px] font-semibold text-accent">Edit →</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
