import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/room";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { deleteRoom, getRoom, getRooms, saveRoom, type CatalogRoom } from "~/lib/catalog.server";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";
import { uploadCatalogRoomImage } from "~/lib/images.server";
import { FIELD_INPUT } from "~/components/admin-form";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) throw redirect("/admin/rooms");

  const isNew = params.roomId === "new";
  const room = isNew ? null : await getRoom(propertyId, params.roomId);
  if (!isNew && !room) throw redirect("/admin/rooms");
  return { isNew, room };
}

export async function action({ params, request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };

  const form = await request.formData();
  const isNew = params.roomId === "new";

  if (form.get("intent") === "delete" && !isNew) {
    await deleteRoom(propertyId, params.roomId);
    await queueGoogleAriPush(propertyId, ["property_data", "ari"]);
    return redirect("/admin/rooms");
  }

  const existing = isNew ? undefined : await getRoom(propertyId, params.roomId);
  const id = existing?.id ?? crypto.randomUUID();

  const title = String(form.get("title") ?? "").trim();
  if (!title) return { error: "Enter a room name." };

  const keep = form.getAll("keepImage").map(String);
  const urls = String(form.get("imageUrls") ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const files = form.getAll("uploads").filter((f): f is File => f instanceof File && f.size > 0);
  const uploaded: string[] = [];
  try {
    for (const file of files) uploaded.push(await uploadCatalogRoomImage(propertyId, id, file));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Upload failed." };
  }

  const posInt = (v: FormDataEntryValue | null, min = 1) => Math.max(min, Math.round(Number(v) || min));
  const rooms = await getRooms(propertyId);
  const room: CatalogRoom = {
    id,
    title,
    description: String(form.get("description") ?? "").trim() || undefined,
    images: [...keep, ...uploaded, ...urls],
    maxAdults: posInt(form.get("maxAdults")),
    maxGuests: posInt(form.get("maxGuests")),
    cleaningFee: Math.max(0, Math.round((Number(form.get("cleaningFee")) || 0) * 100) / 100) || undefined,
    facilities: String(form.get("facilities") ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    position: existing?.position ?? rooms.length,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  await saveRoom(propertyId, room);
  await queueGoogleAriPush(propertyId, ["property_data", "ari"]);
  return isNew ? redirect(`/admin/rooms/${id}`) : { ok: true };
}

export function meta() {
  return [{ title: "Admin · Room" }];
}

export default function AdminRoom({ loaderData, actionData }: Route.ComponentProps) {
  const { isNew, room } = loaderData;
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const existing = room?.images ?? [];

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
          {isNew ? "New room" : room?.title}
        </h1>
        {actionData && "ok" in actionData && actionData.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            ✓ Saved
          </span>
        )}
      </div>

      <Form
        method="post"
        encType="multipart/form-data"
        className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6"
      >
        <label className="block text-[13px] font-semibold text-secondary">
          Room name
          <input name="title" defaultValue={room?.title} placeholder="Executive Twin/Double" className={FIELD_INPUT} />
        </label>

        <label className="block text-[13px] font-semibold text-secondary">
          Description
          <textarea
            name="description"
            rows={5}
            defaultValue={room?.description}
            placeholder="Describe this room…"
            className={`${FIELD_INPUT} resize-y`}
          />
        </label>

        <div className="grid grid-cols-2 gap-5">
          <label className="block text-[13px] font-semibold text-secondary">
            Max adults
            <input name="maxAdults" type="number" min={1} defaultValue={room?.maxAdults ?? 2} className={FIELD_INPUT} />
          </label>
          <label className="block text-[13px] font-semibold text-secondary">
            Sleeps (total guests)
            <input name="maxGuests" type="number" min={1} defaultValue={room?.maxGuests ?? 2} className={FIELD_INPUT} />
          </label>
        </div>

        <label className="block text-[13px] font-semibold text-secondary">
          Cleaning fee <span className="font-normal text-faint">(per stay, optional — VAT applies)</span>
          <input
            name="cleaningFee"
            type="number"
            min={0}
            step="0.01"
            defaultValue={room?.cleaningFee ?? ""}
            placeholder="0.00"
            className={FIELD_INPUT}
          />
        </label>

        <label className="block text-[13px] font-semibold text-secondary">
          Facilities <span className="font-normal text-faint">(one per line)</span>
          <textarea
            name="facilities"
            rows={4}
            defaultValue={room?.facilities.join("\n")}
            placeholder={"Free Wi-Fi\nEn-suite bathroom\nAir conditioning"}
            className={`${FIELD_INPUT} resize-y`}
          />
        </label>

        {existing.length > 0 && (
          <div>
            <div className="mb-2 text-[13px] font-semibold text-secondary">Current photos</div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {existing.map((src) => (
                <label key={src} className="block cursor-pointer">
                  <img src={src} alt="" className="h-28 w-full rounded-[10px] object-cover" />
                  <span className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-secondary">
                    <input type="checkbox" name="keepImage" value={src} defaultChecked />
                    Keep
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        <label className="block text-[13px] font-semibold text-secondary">
          Upload photos
          <input
            type="file"
            name="uploads"
            multiple
            accept="image/*"
            className="mt-1.5 block w-full text-[13px] text-secondary file:mr-3 file:rounded-[8px] file:border-0 file:bg-accent file:px-4 file:py-2 file:text-[13px] file:font-semibold file:text-white hover:file:bg-accent-deep"
          />
          <span className="mt-1 block text-[11px] font-normal text-faint">
            JPG/PNG/WebP, up to 8MB each. {isNew ? "Saved once you create the room." : "Uploaded to your R2 bucket."}
          </span>
        </label>

        <label className="block text-[13px] font-semibold text-secondary">
          Or add image URLs (one per line)
          <textarea
            name="imageUrls"
            rows={2}
            placeholder="https://…/photo.jpg"
            className={`${FIELD_INPUT} resize-y font-mono text-[13px]`}
          />
        </label>

        {actionData && "error" in actionData && actionData.error && (
          <p className="text-[13px] text-red-600">{actionData.error}</p>
        )}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? "Saving…" : isNew ? "Create room" : "Save room"}
          </button>
        </div>
      </Form>

      {!isNew && (
        <Form
          method="post"
          className="mt-4"
          onSubmit={(e) => {
            if (!confirm("Delete this room and its rates?")) e.preventDefault();
          }}
        >
          <button
            type="submit"
            name="intent"
            value="delete"
            className="text-[13px] font-semibold text-[#c0392b] hover:underline"
          >
            Delete room
          </button>
        </Form>
      )}
    </div>
  );
}
