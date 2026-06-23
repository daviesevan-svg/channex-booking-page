import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/room";
import { requireAdmin } from "~/lib/auth.server";
import { getChannexClient, getConfig } from "~/lib/config.server";
import { langFromRequest, pickLang } from "~/lib/content";
import { uploadRoomImage } from "~/lib/images.server";
import { getRoomOverride, putRoomOverride } from "~/lib/overrides.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) throw redirect("/admin/rooms");

  const rooms = await getChannexClient().getRooms(propertyId).catch(() => []);
  const room = rooms.find((r) => r.id === params.roomId);
  if (!room) throw redirect("/admin/rooms");

  const lang = langFromRequest(request);
  const override = await getRoomOverride(propertyId, params.roomId, lang);
  return {
    roomId: params.roomId,
    override,
    lang,
    defaults: { name: room.title, description: room.description ?? "" },
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };

  const form = await request.formData();
  const keep = form.getAll("keepImage").map(String);
  const urls = String(form.get("imageUrls") ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const files = form
    .getAll("uploads")
    .filter((f): f is File => f instanceof File && f.size > 0);

  const uploaded: string[] = [];
  try {
    for (const file of files) {
      uploaded.push(await uploadRoomImage(propertyId, params.roomId, file));
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Upload failed." };
  }

  await putRoomOverride(propertyId, params.roomId, pickLang(String(form.get("lang") ?? "")), {
    name: String(form.get("name") ?? ""),
    description: String(form.get("description") ?? ""),
    images: [...keep, ...uploaded, ...urls],
  });
  return { ok: true };
}

export function meta() {
  return [{ title: "Admin · Edit room" }];
}

export default function AdminRoom({ loaderData, actionData }: Route.ComponentProps) {
  const { override, defaults, lang } = loaderData;
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const existing = override.images ?? [];

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
        <h1 className="font-serif text-[26px] font-semibold">{override.name || defaults.name}</h1>
        {actionData?.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            ✓ Saved
          </span>
        )}
      </div>

      <Form
        method="post"
        key={lang}
        encType="multipart/form-data"
        className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6"
      >
        <input type="hidden" name="lang" value={lang} />
        <label className="block text-[13px] font-semibold text-secondary">
          Room name
          <input name="name" defaultValue={override.name} placeholder={defaults.name} className={inputCls} />
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
            JPG/PNG/WebP, up to 8MB each. Uploaded to your R2 bucket.
          </span>
        </label>

        <label className="block text-[13px] font-semibold text-secondary">
          Or add image URLs (one per line)
          <textarea
            name="imageUrls"
            rows={2}
            placeholder="https://…/photo.jpg"
            className={`${inputCls} resize-y font-mono text-[13px]`}
          />
        </label>

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
