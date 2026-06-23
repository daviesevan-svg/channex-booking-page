import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/room";
import { requireAdmin } from "~/lib/auth.server";
import { getChannexClient, getConfig } from "~/lib/config.server";
import { getRoomOverride, saveRoomOverride } from "~/lib/overrides.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) throw redirect("/admin/rooms");

  const rooms = await getChannexClient().getRooms(propertyId).catch(() => []);
  const room = rooms.find((r) => r.id === params.roomId);
  if (!room) throw redirect("/admin/rooms");

  const override = await getRoomOverride(propertyId, params.roomId);
  return {
    roomId: params.roomId,
    override,
    defaults: { name: room.title, description: room.description ?? "" },
    channexPhotos: (room.photos ?? []).map((p) => p.url),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };
  const form = await request.formData();
  await saveRoomOverride(propertyId, params.roomId, Object.fromEntries(form));
  return { ok: true };
}

export function meta() {
  return [{ title: "Admin · Edit room" }];
}

export default function AdminRoom({ loaderData, actionData }: Route.ComponentProps) {
  const { override, defaults, channexPhotos } = loaderData;
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  const inputCls =
    "mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[11px] text-[15px] text-ink outline-none focus:border-accent";

  return (
    <div>
      <Link
        to="/admin/rooms"
        className="mb-4 inline-block text-[13px] font-semibold text-muted hover:text-accent"
      >
        ← All rooms
      </Link>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">
          {override.name || defaults.name}
        </h1>
        {actionData?.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            ✓ Saved
          </span>
        )}
      </div>

      <Form
        method="post"
        className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6"
      >
        <label className="block text-[13px] font-semibold text-secondary">
          Room name
          <input
            name="name"
            defaultValue={override.name}
            placeholder={defaults.name}
            className={inputCls}
          />
        </label>

        <label className="block text-[13px] font-semibold text-secondary">
          Description
          <textarea
            name="description"
            rows={5}
            defaultValue={override.description}
            placeholder={defaults.description || "Describe this room…"}
            className={`${inputCls} resize-y`}
          />
        </label>

        <label className="block text-[13px] font-semibold text-secondary">
          Photos (one image URL per line)
          <textarea
            name="images"
            rows={4}
            defaultValue={(override.images ?? []).join("\n")}
            placeholder={"https://…/room-1.jpg\nhttps://…/room-2.jpg"}
            className={`${inputCls} resize-y font-mono text-[13px]`}
          />
          <span className="mt-1 block text-[11px] font-normal text-faint">
            {channexPhotos.length
              ? `Channex provides ${channexPhotos.length} photo(s); your URLs replace them.`
              : "Channex has no photos for this room — add your own."}
          </span>
        </label>

        {override.images && override.images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {override.images.map((url) => (
              <img
                key={url}
                src={url}
                alt=""
                className="h-16 w-24 rounded-[8px] object-cover"
              />
            ))}
          </div>
        )}

        {actionData?.error && <p className="text-[13px] text-red-600">{actionData.error}</p>}
        <div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save room"}
          </button>
        </div>
      </Form>
    </div>
  );
}
