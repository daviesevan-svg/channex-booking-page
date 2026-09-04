import { Form, useNavigation, useRevalidator } from "react-router";
import { useState } from "react";

import type { Route } from "./+types/gallery";
import { adminMeta } from "~/lib/admin-meta";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { langParam, pickLang } from "~/lib/content";
import { MAX_GALLERY_IMAGES, type GalleryText } from "~/lib/gallery";
import { getGallery, removeImage, saveGalleryLang } from "~/lib/gallery.server";
import { queueImageCleanup } from "~/lib/image-gc.server";
import { FIELD_INPUT, TranslationNote } from "~/components/admin-form";
import { PhotoUploader } from "~/components/admin-photo-uploader";
import { AdminPageHeader } from "~/components/admin-page-header";
import { useAdminT } from "~/lib/admin-i18n";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const lang = langParam(request);
  const gallery = await getGallery(propertyId);
  return {
    configured: true as const,
    lang,
    images: gallery.images,
    text: gallery.text[lang] ?? {},
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No property selected." };

  // See upload-limits.ts: an oversized multipart body dies inside formData(),
  // before any error handling of ours, and surfaced as root's generic
  // ErrorBoundary rather than anything an admin could act on.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { error: "Could not read the upload — it may be too large. Try fewer or smaller images." };
  }
  const lang = pickLang(String(form.get("lang") ?? ""));

  // Uploads no longer arrive here at all — each image is its own request to
  // gallery-photo.tsx, which stores it and adds it. What is left is the order +
  // captions save, and the deletes below.
  // Save order + this language's text BEFORE handling a delete, so pending
  // edits in the other rows aren't thrown away by clicking a remove button.
  const order = form.getAll("imageId").map(String);
  const text: Record<string, GalleryText> = {};
  for (const id of order) {
    text[id] = {
      alt: String(form.get(`alt:${id}`) ?? ""),
      caption: String(form.get(`caption:${id}`) ?? ""),
    };
  }
  await saveGalleryLang(propertyId, lang, order, text);

  const remove = String(form.get("remove") ?? "");
  if (remove) {
    queueImageCleanup(propertyId, await removeImage(propertyId, remove));
    return { removed: true as const };
  }
  return { ok: true as const };
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "galTitle" });
}

export default function AdminGallery({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const t = useAdminT();

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("galTitle")}</h1>
        <p className="text-[15px] text-secondary">{t("galAddPropertyFirst")}</p>
      </div>
    );
  }

  const { images, text, lang } = loaderData;
  return (
    <GalleryEditor
      key={`${lang}:${images.map((i) => i.id).join(",")}`}
      images={images}
      text={text}
      lang={lang}
      saving={saving}
      error={actionData && "error" in actionData ? actionData.error : undefined}
      saved={Boolean(actionData && "ok" in actionData && actionData.ok)}
      t={t}
    />
  );
}

function GalleryEditor({
  images,
  text,
  lang,
  saving,
  error,
  saved,
  t,
}: {
  images: { id: string; url: string }[];
  text: Record<string, GalleryText>;
  lang: string;
  saving: boolean;
  error?: string;
  saved: boolean;
  t: ReturnType<typeof useAdminT>;
}) {
  // The uploader commits each image itself, so a finished batch refreshes the
  // loader rather than arriving as an action result.
  const revalidator = useRevalidator();
  // Local order so the arrows reorder instantly; hidden inputs are rendered
  // from this, and one save persists it. Rows are keyed by image id, so React
  // carries each row's typed-but-unsaved text along with the move. The parent
  // keys this component on the server's id order, so a save or delete remounts
  // it with fresh state rather than needing to sync back.
  const [order, setOrder] = useState(images);

  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
  };

  return (
    <div>
      <AdminPageHeader title={t("galTitle")} saved={Boolean(saved)} />
      <p className="mb-6 text-[14px] text-muted">{t("galIntro")}</p>
      <TranslationNote lang={lang} />

      {/* Upload — its own form so a file pick can't carry the text fields. */}
      {/* Not a form any more: each image is its own request, stored and added
          by gallery-photo.tsx as it arrives. There is nothing left to submit,
          so the Upload button is gone — picking the files IS the upload — and
          the grid below refreshes as they land. */}
      <div className="mb-6 rounded-[14px] border border-line bg-surface p-6">
        <div className="mb-1 font-serif text-[18px] font-semibold">{t("galAdd")}</div>
        <p className="mb-3 text-[13px] text-muted">
          {t("galAddHint", { max: MAX_GALLERY_IMAGES, used: order.length })}
        </p>
        <PhotoUploader
          endpoint="/admin/gallery/photo"
          staged={false}
          onComplete={() => revalidator.revalidate()}
          room={MAX_GALLERY_IMAGES - order.length}
          disabledReason={
            order.length >= MAX_GALLERY_IMAGES
              ? t("galAddHint", { max: MAX_GALLERY_IMAGES, used: order.length })
              : undefined
          }
        />
        <p className="mt-2 text-[12px] text-faint">{t("homeImageFormats")}</p>
      </div>

      {error && (
        <p className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error}
        </p>
      )}

      {order.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-line-alt bg-surface-alt p-10 text-center text-[14px] text-muted">
          {t("galEmpty")}
        </div>
      ) : (
        <Form method="post" className="flex flex-col gap-4">
          <input type="hidden" name="lang" value={lang} />
          <input type="hidden" name="op" value="save" />
          {order.map((img, i) => (
            <div
              key={img.id}
              className="flex flex-wrap items-start gap-4 rounded-[14px] border border-line bg-surface p-4"
            >
              <input type="hidden" name="imageId" value={img.id} />
              <div className="h-[90px] w-[140px] flex-none overflow-hidden rounded-[10px] border border-line-alt bg-surface-alt">
                <img src={img.url} alt="" className="h-full w-full object-cover" />
              </div>
              <div className="flex min-w-[240px] flex-1 flex-col gap-2.5">
                <label className="block text-[13px] font-semibold text-secondary">
                  {t("galAlt")}
                  <input
                    name={`alt:${img.id}`}
                    defaultValue={text[img.id]?.alt ?? ""}
                    placeholder={t("galAltPlaceholder")}
                    className={FIELD_INPUT}
                  />
                </label>
                <label className="block text-[13px] font-semibold text-secondary">
                  {t("galCaption")}
                  <input
                    name={`caption:${img.id}`}
                    defaultValue={text[img.id]?.caption ?? ""}
                    className={FIELD_INPUT}
                  />
                </label>
              </div>
              <div className="flex flex-none flex-col gap-1.5">
                <div className="flex gap-1.5">
                  <MoveButton onClick={() => move(i, -1)} disabled={i === 0} label="↑" title={t("galMoveUp")} />
                  <MoveButton
                    onClick={() => move(i, 1)}
                    disabled={i === order.length - 1}
                    label="↓"
                    title={t("galMoveDown")}
                  />
                </div>
                <button
                  type="submit"
                  name="remove"
                  value={img.id}
                  disabled={saving}
                  className="cursor-pointer rounded-[8px] border border-line px-3 py-1.5 text-[13px] font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60"
                >
                  {t("galDelete")}
                </button>
              </div>
            </div>
          ))}
          <div>
            <button
              type="submit"
              disabled={saving}
              className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
            >
              {saving ? t("saving") : t("saveChanges")}
            </button>
          </div>
        </Form>
      )}
    </div>
  );
}

function MoveButton({
  onClick,
  disabled,
  label,
  title,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="cursor-pointer rounded-[8px] border border-line px-3 py-1.5 text-[14px] font-semibold text-secondary hover:bg-chip disabled:cursor-default disabled:opacity-35"
    >
      {label}
    </button>
  );
}
