import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/room";
import { adminMeta } from "~/lib/admin-meta";
import { useAdminT } from "~/lib/admin-i18n";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { deleteRoom, getRoom, getRooms, saveRoom, type CatalogRoom, type RoomTranslation } from "~/lib/catalog.server";
import { DEFAULT_LANG, langParam, pickLang, VR_AMENITY_KEYS } from "~/lib/content";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";
import { queueImageCleanup } from "~/lib/image-gc.server";
import { uploadCatalogRoomImage } from "~/lib/images.server";
import { dedupeImages, parsePastedImageUrls, pastedUrlError } from "~/lib/pasted-image-urls";
import { attachedFiles, checkUploadBatch, uploadProblemMessage } from "~/lib/upload-limits";
import { AmenitiesPicker } from "~/components/amenities-picker";
import { FIELD_INPUT, FilePicker, TranslationNote } from "~/components/admin-form";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) throw redirect("/admin/rooms");

  const isNew = params.roomId === "new";
  const room = isNew ? null : await getRoom(propertyId, params.roomId);
  if (!isNew && !room) throw redirect("/admin/rooms");
  // A new room is always created in the default language — there is no default
  // text to translate yet — so the editor ignores the language tab until saved.
  const lang = isNew ? DEFAULT_LANG : langParam(request);
  // RAW per-language text, empty until translated (see TranslationNote) — the
  // default-language content must never appear editable on a translation tab,
  // or saving it writes the default text into the translation (or worse).
  const tr: RoomTranslation = lang === DEFAULT_LANG ? {} : (room?.translations?.[lang] ?? {});
  return { isNew, room, lang, tr };
}

export async function action({ params, request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };

  // Reading the body can fail before any of our own validation gets a look in —
  // an oversized multipart upload is refused by the platform, and a Worker that
  // runs out of memory buffering it dies here. Unguarded, that reached root's
  // ErrorBoundary as "An unexpected error occurred", which tells an admin
  // nothing about the photos they just attached. The batch limits below are
  // what stop it happening; this is the message if something still does.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { error: "Could not read the upload — it may be too large. Try fewer or smaller photos." };
  }
  const isNew = params.roomId === "new";

  if (form.get("intent") === "delete" && !isNew) {
    // Read the photos before the row goes, or there's nothing left to name them.
    const gone = (await getRoom(propertyId, params.roomId))?.images ?? [];
    await deleteRoom(propertyId, params.roomId);
    queueImageCleanup(propertyId, gone);
    await queueGoogleAriPush(propertyId, ["property_data", "ari"]);
    return redirect("/admin/rooms");
  }

  const existing = isNew ? undefined : await getRoom(propertyId, params.roomId);
  const id = existing?.id ?? crypto.randomUUID();

  // The language tab the form was rendered under. New rooms always save the
  // default: there is no default text to translate yet.
  const lang = isNew ? DEFAULT_LANG : pickLang(String(form.get("lang") ?? ""));
  const onDefault = lang === DEFAULT_LANG;

  const title = String(form.get("title") ?? "").trim();
  // A translation tab may leave any text blank (= fall back to the default),
  // but the default name is what everything falls back TO, so it must exist.
  if (onDefault && !title) return { error: "Enter a room name." };

  const keep = form.getAll("keepImage").map(String);
  // Refuse a mistyped url instead of storing it: it would become a permanently
  // broken photo on the guest page with nothing to say why.
  const pasted = parsePastedImageUrls(String(form.get("imageUrls") ?? ""));
  if (pasted.rejected.length) return { error: pastedUrlError(pasted.rejected) };

  const files = attachedFiles(form, "uploads");
  // Checked here as well as in the browser, because the browser check is a
  // courtesy and this one is the rule.
  const tooMuch = checkUploadBatch(files);
  if (tooMuch) return { error: uploadProblemMessage(tooMuch) };

  const uploaded: string[] = [];
  try {
    for (const file of files) uploaded.push(await uploadCatalogRoomImage(propertyId, id, file));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Upload failed." };
  }

  const description = String(form.get("description") ?? "").trim();
  const facilities = String(form.get("facilities") ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  // On a translation tab the three text fields hold THAT language's raw text
  // (empty = untranslated), so they update only translations[lang] — the
  // default text isn't even in the form and must be carried over untouched.
  // Everything else (numbers, amenities, photos) is language-independent and
  // saves the same whichever tab is open.
  let translations = existing?.translations;
  if (!onDefault) {
    const entry: RoomTranslation = {
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(facilities.length ? { facilities } : {}),
    };
    const next = { ...translations };
    if (Object.keys(entry).length) next[lang] = entry;
    else delete next[lang];
    translations = Object.keys(next).length ? next : undefined;
  }

  const posInt = (v: FormDataEntryValue | null, min = 1) => Math.max(min, Math.round(Number(v) || min));
  const rooms = await getRooms(propertyId);
  const room: CatalogRoom = {
    id,
    title: onDefault ? title : (existing?.title ?? title),
    description: onDefault ? description || undefined : existing?.description,
    // Deduped: the three sources can name the same photo (a pasted url that is
    // already kept), and a repeat is both a doubled thumbnail and a duplicate
    // React key in the editor's "Current photos" grid.
    images: dedupeImages([...keep, ...uploaded, ...pasted.urls]),
    maxAdults: posInt(form.get("maxAdults")),
    maxGuests: posInt(form.get("maxGuests")),
    cleaningFee: Math.max(0, Math.round((Number(form.get("cleaningFee")) || 0) * 100) / 100) || undefined,
    facilities: onDefault ? facilities : (existing?.facilities ?? []),
    // Structured amenities — only known vocabulary keys are stored.
    amenities: form.getAll("amenity").map(String).filter((k) => VR_AMENITY_KEYS.has(k)),
    position: existing?.position ?? rooms.length,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    translations,
  };
  await saveRoom(propertyId, room);
  // Unticking "keep" is how a photo is removed here, so the dropped ones are
  // whatever the room had and the new list doesn't.
  const kept = new Set(room.images);
  queueImageCleanup(propertyId, (existing?.images ?? []).filter((u) => !kept.has(u)));
  await queueGoogleAriPush(propertyId, ["property_data", "ari"]);
  // Back to the rooms list after every save. Staying on the editor left the
  // chosen file in the upload input, so a second save re-uploaded it and created
  // a duplicate image; navigating away clears the form. Keep the language tab —
  // resetting the Editing dropdown to the default mid-translation invites the
  // next save to land in the wrong language.
  return redirect(onDefault ? "/admin/rooms" : `/admin/rooms?lang=${lang}`);
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "mtRoom" });
}

export default function AdminRoom({ loaderData, actionData }: Route.ComponentProps) {
  const t = useAdminT();
  const { isNew, room, lang, tr } = loaderData;
  const onDefault = lang === DEFAULT_LANG;
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

      <TranslationNote lang={lang} />

      <Form
        method="post"
        key={lang}
        encType="multipart/form-data"
        className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6"
      >
        <input type="hidden" name="lang" value={lang} />
        <label className="block text-[13px] font-semibold text-secondary">
          {t("rmNameLabel")}
          <input
            name="title"
            defaultValue={onDefault ? room?.title : tr.title}
            placeholder={onDefault ? t("rmNamePlaceholder") : undefined}
            className={FIELD_INPUT}
          />
        </label>

        <label className="block text-[13px] font-semibold text-secondary">
          {t("rmDescriptionLabel")}
          <textarea
            name="description"
            rows={5}
            defaultValue={onDefault ? room?.description : tr.description}
            placeholder={onDefault ? t("rmDescriptionPlaceholder") : undefined}
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
        <p className="-mt-2 text-[12px] text-faint">
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
          <p className="mb-3 text-[12px] text-muted">
            {t("rmAmenitiesIntro")}
          </p>
          <AmenitiesPicker selected={room?.amenities ?? []} />
        </div>

        <label className="block text-[13px] font-semibold text-secondary">
          {t("rmFacilities")} <span className="font-normal text-faint">{t("rmFacilitiesHint")}</span>
          <textarea
            name="facilities"
            rows={4}
            defaultValue={onDefault ? room?.facilities.join("\n") : tr.facilities?.join("\n")}
            placeholder={onDefault ? t("rmFacilitiesPlaceholder") : undefined}
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
                  <span className="mt-1.5 flex items-center gap-1.5 text-[12px] text-secondary">
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
