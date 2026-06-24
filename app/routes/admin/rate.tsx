import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/rate";
import { requireAdmin } from "~/lib/auth.server";
import { getConfig } from "~/lib/config.server";
import { langParam, pickLang } from "~/lib/content";
import { uploadRatePlanImage } from "~/lib/images.server";
import { getRatePlanList } from "~/lib/rateplans.server";
import { getRatePlanOverride, putRatePlanOverride } from "~/lib/overrides.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) throw redirect("/admin/rates");

  const rates = await getRatePlanList(propertyId).catch(() => []);
  const rate = rates.find((r) => r.key === params.rateId);
  if (!rate) throw redirect("/admin/rates");

  const lang = langParam(request);
  const override = await getRatePlanOverride(propertyId, params.rateId, lang);
  return {
    rateId: params.rateId,
    override,
    lang,
    defaults: {
      name: rate.channexTitle,
      rooms: rate.rooms.join(", "),
      cancellation: rate.cancellationTitle ?? "",
      cancelValue: rate.channexCancelValue,
      cancelUnit: rate.channexCancelUnit,
    },
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
  const inclusions = String(form.get("inclusions") ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const files = form.getAll("uploads").filter((f): f is File => f instanceof File && f.size > 0);

  const uploaded: string[] = [];
  try {
    for (const file of files) {
      uploaded.push(await uploadRatePlanImage(propertyId, params.rateId, file));
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Upload failed." };
  }

  const posInt = (v: FormDataEntryValue | null) => {
    const n = parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const unit = (v: FormDataEntryValue | null) => {
    const u = String(v ?? "");
    return u === "hours" || u === "days" ? u : undefined;
  };

  await putRatePlanOverride(propertyId, params.rateId, pickLang(String(form.get("lang") ?? "")), {
    name: String(form.get("name") ?? ""),
    description: String(form.get("description") ?? ""),
    inclusions,
    cancellation: String(form.get("cancellation") ?? ""),
    images: [...keep, ...uploaded, ...urls],
    refundable: form.get("refundable") === "on",
    cancelDeadlineValue: posInt(form.get("cancelDeadlineValue")),
    cancelDeadlineUnit: unit(form.get("cancelDeadlineUnit")),
    modifyDeadlineValue: posInt(form.get("modifyDeadlineValue")),
    modifyDeadlineUnit: unit(form.get("modifyDeadlineUnit")),
  });
  return { ok: true };
}

export function meta() {
  return [{ title: "Admin · Edit rate plan" }];
}

export default function AdminRate({ loaderData, actionData }: Route.ComponentProps) {
  const { override, defaults, lang } = loaderData;
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const existing = override.images ?? [];

  const inputCls =
    "mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[11px] text-[15px] text-ink outline-none focus:border-accent";

  return (
    <div>
      <Link
        to="/admin/rates"
        className="mb-4 inline-block text-[13px] font-semibold text-muted hover:text-accent"
      >
        ← All rates
      </Link>
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">{override.name || defaults.name}</h1>
        {actionData?.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            ✓ Saved
          </span>
        )}
      </div>
      <p className="mb-5 text-[13px] text-muted-2">Applies to: {defaults.rooms}</p>

      <Form
        method="post"
        key={lang}
        encType="multipart/form-data"
        className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6"
      >
        <input type="hidden" name="lang" value={lang} />
        <label className="block text-[13px] font-semibold text-secondary">
          Rate name
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
            rows={4}
            defaultValue={override.description}
            placeholder="Describe this rate, e.g. includes breakfast for two…"
            className={`${inputCls} resize-y`}
          />
        </label>

        <label className="block text-[13px] font-semibold text-secondary">
          What&rsquo;s included (one per line)
          <textarea
            name="inclusions"
            rows={4}
            defaultValue={(override.inclusions ?? []).join("\n")}
            placeholder={"Full English breakfast\nFree cancellation up to 24h\nWelcome drink"}
            className={`${inputCls} resize-y`}
          />
        </label>

        <fieldset className="rounded-[12px] border border-line-alt p-4">
          <legend className="px-1.5 text-[13px] font-semibold text-secondary">
            Cancellation &amp; changes
          </legend>
          <label className="flex items-center gap-2.5 text-[14px] font-semibold">
            <input
              type="checkbox"
              name="refundable"
              defaultChecked={override.refundable ?? true}
              className="h-4 w-4 rounded border-line-alt text-accent focus:ring-accent"
            />
            Refundable (guests can cancel for a refund)
          </label>

          <div className="mt-4 text-[13px] font-semibold text-secondary">Free cancellation up to</div>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              name="cancelDeadlineValue"
              type="number"
              min={0}
              defaultValue={override.cancelDeadlineValue ?? defaults.cancelValue ?? ""}
              placeholder="0"
              className="w-24 rounded-[10px] border border-line-alt bg-surface-alt px-3 py-[10px] text-[15px] text-ink outline-none focus:border-accent"
            />
            <select
              name="cancelDeadlineUnit"
              defaultValue={override.cancelDeadlineUnit ?? defaults.cancelUnit ?? "hours"}
              className="rounded-[10px] border border-line-alt bg-surface-alt px-3 py-[11px] text-[15px] text-ink outline-none focus:border-accent"
            >
              <option value="days">days</option>
              <option value="hours">hours</option>
            </select>
            <span className="text-[13px] text-muted-2">before arrival</span>
          </div>

          <div className="mt-4 text-[13px] font-semibold text-secondary">Changes allowed up to</div>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              name="modifyDeadlineValue"
              type="number"
              min={0}
              defaultValue={override.modifyDeadlineValue ?? ""}
              placeholder="0"
              className="w-24 rounded-[10px] border border-line-alt bg-surface-alt px-3 py-[10px] text-[15px] text-ink outline-none focus:border-accent"
            />
            <select
              name="modifyDeadlineUnit"
              defaultValue={override.modifyDeadlineUnit ?? "days"}
              className="rounded-[10px] border border-line-alt bg-surface-alt px-3 py-[11px] text-[15px] text-ink outline-none focus:border-accent"
            >
              <option value="days">days</option>
              <option value="hours">hours</option>
            </select>
            <span className="text-[13px] text-muted-2">before arrival</span>
          </div>
          <p className="mt-2 text-[11px] text-faint">
            Leave a value blank for no time limit. The Customer Portal master switches and these
            windows decide when guests can cancel or change a booking.
          </p>
        </fieldset>

        <label className="block text-[13px] font-semibold text-secondary">
          Cancellation note shown to guests (optional)
          <input
            name="cancellation"
            defaultValue={override.cancellation}
            placeholder={defaults.cancellation || "e.g. Free cancellation up to 24h before arrival"}
            className={inputCls}
          />
          <span className="mt-1 block text-[11px] font-normal text-faint">
            Free-text wording shown on the rate. Leave blank to use the Channex policy
            {defaults.cancellation ? ` (“${defaults.cancellation}”)` : ""}.
          </span>
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
            {saving ? "Saving…" : "Save rate"}
          </button>
        </div>
      </Form>
    </div>
  );
}
