import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/room";
import { useAdminT } from "~/lib/admin-i18n";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { deleteRoom, getRoom, getRooms, saveRoom, type CatalogRoom } from "~/lib/catalog.server";
import { VR_AMENITY_KEYS } from "~/lib/content";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";
import { uploadCatalogRoomImage } from "~/lib/images.server";
import { AmenitiesPicker } from "~/components/amenities-picker";
import { FIELD_INPUT, FilePicker } from "~/components/admin-form";

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
    // Structured amenities — only known vocabulary keys are stored.
    amenities: form.getAll("amenity").map(String).filter((k) => VR_AMENITY_KEYS.has(k)),
    position: existing?.position ?? rooms.length,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  await saveRoom(propertyId, room);
  await queueGoogleAriPush(propertyId, ["property_data", "ari"]);
  // Back to the rooms list after every save. Staying on the editor left the
  // chosen file in the upload input, so a second save re-uploaded it and created
  // a duplicate image; navigating away clears the form.
  return redirect("/admin/rooms");
}

export function meta() {
  return [{ title: "Admin · Room" }];
}

export default function AdminRoom({ loaderData, actionData }: Route.ComponentProps) {
  const t = useAdminT();
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
        {t("rmBackAll")}
      </Link>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">
          {isNew ? t("rmNewTitle") : room?.title}
        </h1>
      </div>

      <Form
        method="post"
        encType="multipart/form-data"
        className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6"
      >
        <label className="block text-[13px] font-semibold text-secondary">
          {t("rmNameLabel")}
          <input name="title" defaultValue={room?.title} placeholder={t("rmNamePlaceholder")} className={FIELD_INPUT} />
        </label>

        <label className="block text-[13px] font-semibold text-secondary">
          {t("rmDescriptionLabel")}
          <textarea
            name="description"
            rows={5}
            defaultValue={room?.description}
            placeholder={t("rmDescriptionPlaceholder")}
            className={`${FIELD_INPUT} resize-y`}
          />
        </label>

        <div className="grid grid-cols-2 gap-5">
          <label className="block text-[13px] font-semibold text-secondary">
            {t("rmMaxAdults")}
            <input name="maxAdults" type="number" min={1} defaultValue={room?.maxAdults ?? 2} className={FIELD_INPUT} />
          </label>
          <label className="block text-[13px] font-semibold text-secondary">
            {t("rmSleepsLabel")} <span className="font-normal text-faint">{t("rmSleepsHint")}</span>
            <input name="maxGuests" type="number" min={1} defaultValue={room?.maxGuests ?? 2} className={FIELD_INPUT} />
          </label>
        </div>
        <p className="-mt-2 text-[12.5px] text-faint">
          {t("rmChildrenNote")}
        </p>

        <label className="block text-[13px] font-semibold text-secondary">
          {t("rmCleaningFee")} <span className="font-normal text-faint">{t("rmCleaningFeeHint")}</span>
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

        <div>
          <div className="mb-2 text-[13px] font-semibold text-secondary">{t("rmAmenitiesTitle")}</div>
          <p className="mb-3 text-[12.5px] text-muted">
            {t("rmAmenitiesIntro")}
          </p>
          <AmenitiesPicker selected={room?.amenities ?? []} />
        </div>

        <label className="block text-[13px] font-semibold text-secondary">
          {t("rmFacilities")} <span className="font-normal text-faint">{t("rmFacilitiesHint")}</span>
          <textarea
            name="facilities"
            rows={4}
            defaultValue={room?.facilities.join("\n")}
            placeholder={t("rmFacilitiesPlaceholder")}
            className={`${FIELD_INPUT} resize-y`}
          />
        </label>

        {existing.length > 0 && (
          <div>
            <div className="mb-2 text-[13px] font-semibold text-secondary">{t("rmCurrentPhotos")}</div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {existing.map((src) => (
                <label key={src} className="block cursor-pointer">
                  <img src={src} alt="" className="h-28 w-full rounded-[10px] object-cover" />
                  <span className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-secondary">
                    <input type="checkbox" name="keepImage" value={src} defaultChecked />
                    {t("rmKeep")}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="mb-1.5 text-[13px] font-semibold text-secondary">{t("rmUploadPhotos")}</div>
          <FilePicker name="uploads" accept="image/*" multiple />
          <span className="mt-1 block text-[11px] font-normal text-faint">
            {t("rmUploadFormats")} {isNew ? t("rmUploadNewHint") : t("rmUploadExistingHint")}
          </span>
        </div>

        <label className="block text-[13px] font-semibold text-secondary">
          {t("rmImageUrls")}
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
            {saving ? t("saving") : isNew ? t("rmCreate") : t("rmSave")}
          </button>
        </div>
      </Form>

      {!isNew && (
        <Form
          method="post"
          className="mt-4"
          onSubmit={(e) => {
            if (!confirm(t("rmDeleteConfirm"))) e.preventDefault();
          }}
        >
          <button
            type="submit"
            name="intent"
            value="delete"
            className="text-[13px] font-semibold text-[#c0392b] hover:underline"
          >
            {t("rmDelete")}
          </button>
        </Form>
      )}
    </div>
  );
}
