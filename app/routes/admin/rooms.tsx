import { Link } from "react-router";

import type { Route } from "./+types/rooms";
import { useAdminT } from "~/lib/admin-i18n";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getRates, getRooms } from "~/lib/catalog.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const [rooms, rates] = await Promise.all([getRooms(propertyId), getRates(propertyId)]);
  return {
    configured: true as const,
    rooms: rooms.map((r) => ({
      id: r.id,
      title: r.title,
      maxAdults: r.maxAdults,
      maxGuests: r.maxGuests,
      image: r.images[0] ?? null,
      images: r.images.length,
      rateCount: rates.filter((rt) => rt.prices[r.id] !== undefined).length,
    })),
  };
}

export function meta() {
  return [{ title: "Admin · Rooms" }];
}

export default function AdminRooms({ loaderData }: Route.ComponentProps) {
  const t = useAdminT();
  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("rmTitle")}</h1>
        <p className="text-[15px] text-secondary">
          {t("rmConfigurePrefix")} <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code>{" "}
          {t("rmConfigureSuffix")}
        </p>
      </div>
    );
  }

  const { rooms } = loaderData;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">{t("rmTitle")}</h1>
        <Link
          to="/admin/rooms/new"
          className="rounded-[10px] bg-accent px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep"
        >
          {t("rmNew")}
        </Link>
      </div>
      <p className="mb-6 text-[14px] text-muted">
        {t("rmIntro")}
      </p>

      {rooms.length === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-6 text-[14px] text-secondary">
          {t("rmEmpty")}
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
              <div className="flex min-w-0 items-center gap-3.5">
                {room.image ? (
                  <img src={room.image} alt="" className="h-11 w-16 flex-none rounded-[8px] border border-line object-cover" />
                ) : (
                  <div className="h-11 w-16 flex-none rounded-[8px] border border-line" style={{ background: "repeating-linear-gradient(135deg,#efe7da,#efe7da 8px,#e7ddcc 8px,#e7ddcc 16px)" }} />
                )}
                <div className="min-w-0">
                <div className="truncate font-semibold">{room.title}</div>
                <div className="mt-0.5 text-[12.5px] text-muted-2">
                  {t("rmSleeps", { n: room.maxGuests })} ·{" "}
                  {t(room.maxAdults === 1 ? "rmUpToAdults_one" : "rmUpToAdults_other", { n: room.maxAdults })} ·{" "}
                  {t(room.images === 1 ? "rmPhotos_one" : "rmPhotos_other", { n: room.images })} ·{" "}
                  {t(room.rateCount === 1 ? "rmRates_one" : "rmRates_other", { n: room.rateCount })}
                </div>
                </div>
              </div>
              <span className="flex-none text-[13px] font-semibold text-accent">{t("rmEdit")}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
