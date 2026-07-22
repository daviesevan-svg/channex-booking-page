import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/extras";
import { FIELD_INPUT, FilePicker } from "~/components/admin-form";
import { useAdminT, type AdminT } from "~/lib/admin-i18n";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getSettings } from "~/lib/overrides.server";
import { formatMoney } from "~/lib/money";
import {
  UNIT_LABEL,
  isConfigurable,
  scopeOf,
  type Extra,
  type ExtraField,
  type ExtraOption,
  type ExtraScope,
  type ExtraUnit,
} from "~/lib/extras";
import { deleteExtra, ensureExampleExtras, getExtras, saveExtra, toggleExtra } from "~/lib/extras.server";
import { uploadExtraImage } from "~/lib/images.server";
import { getRates, getRooms } from "~/lib/catalog.server";

const UNITS: ExtraUnit[] = ["stay", "night", "person", "person_night", "trip"];

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || Math.random().toString(36).slice(2, 8)
  );
}

/** Parse one "Name | price | [unit] | [description]" option line. */
function parseOptionLine(line: string, used: Set<string>): ExtraOption | null {
  const parts = line.split("|").map((p) => p.trim());
  const name = parts[0];
  const price = Math.round(Number(parts[1]) * 100) / 100;
  if (!name || !Number.isFinite(price) || price <= 0) return null;
  const rest = parts.slice(2);
  let unit: ExtraUnit | undefined;
  if (rest[0] && (UNITS as string[]).includes(rest[0])) unit = rest.shift() as ExtraUnit;
  const desc = rest.join(" | ").trim() || undefined;
  let id = slug(name);
  while (used.has(id)) id = `${id}-x`;
  used.add(id);
  return { id, name, price, unit, desc };
}

/** Parse one "*Label | placeholder" info-field line ("*" marks required). */
function parseFieldLine(line: string, used: Set<string>): ExtraField | null {
  let raw = line.trim();
  if (!raw) return null;
  const required = raw.startsWith("*");
  if (required) raw = raw.slice(1).trim();
  const [label, placeholder] = raw.split("|").map((p) => p.trim());
  if (!label) return null;
  let id = slug(label);
  while (used.has(id)) id = `${id}-x`;
  used.add(id);
  return { id, label, short: label.split(/\s+/)[0], placeholder: placeholder || undefined, required };
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  // Seed example extras on first visit so owners start from something editable.
  await ensureExampleExtras(propertyId);
  const [extras, settings, rooms, rates] = await Promise.all([
    getExtras(propertyId),
    getSettings(propertyId),
    getRooms(propertyId),
    getRates(propertyId),
  ]);
  const url = new URL(request.url);
  const editId = url.searchParams.get("edit");
  return {
    configured: true as const,
    extras,
    currency: settings.currency || "GBP",
    rooms: rooms.map((r) => ({ id: r.id, title: r.title })),
    rates: rates.map((r) => ({ id: r.id, title: r.title })),
    editing: extras.find((e) => e.id === editId) ?? null,
    creating: url.searchParams.get("new") != null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No property selected." };

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "delete") {
    await deleteExtra(propertyId, String(form.get("id")));
    return redirect("/admin/extras");
  }
  if (intent === "toggle") {
    await toggleExtra(propertyId, String(form.get("id")));
    return redirect("/admin/extras");
  }

  // intent === "save"
  const id = String(form.get("id") || "").trim();
  const name = String(form.get("name") ?? "").trim();
  const desc = String(form.get("desc") ?? "").trim() || undefined;
  const unit = (UNITS as string[]).includes(String(form.get("unit"))) ? (form.get("unit") as ExtraUnit) : "stay";
  const priceRaw = String(form.get("price") ?? "").trim();
  const optionsText = String(form.get("options") ?? "");
  const fieldsText = String(form.get("fields") ?? "");
  const infoTitle = String(form.get("infoTitle") ?? "").trim() || undefined;
  const active = form.get("active") != null;
  const taxable = form.get("taxable") != null;
  const scope: ExtraScope = form.get("scope") === "booking" ? "booking" : "room";
  // Exclusions only apply to room-scoped extras.
  const excludeRooms = scope === "room" ? form.getAll("excludeRooms").map(String).filter(Boolean) : [];
  const excludeRates = scope === "room" ? form.getAll("excludeRates").map(String).filter(Boolean) : [];
  const values = { id, name, desc: desc ?? "", unit, price: priceRaw, options: optionsText, fields: fieldsText, infoTitle: infoTitle ?? "" };

  if (!name) return { error: "Enter a name for the extra.", values };

  const usedOpt = new Set<string>();
  const options = optionsText
    .split("\n")
    .map((l) => parseOptionLine(l, usedOpt))
    .filter((o): o is ExtraOption => o !== null);
  const usedField = new Set<string>();
  const fields = fieldsText
    .split("\n")
    .map((l) => parseFieldLine(l, usedField))
    .filter((f): f is ExtraField => f !== null);

  const configurable = options.length > 0;
  const price = Math.round(Number(priceRaw) * 100) / 100;
  if (!configurable && (!Number.isFinite(price) || price <= 0)) {
    return { error: "Set a price, or add at least one option (one per line).", values };
  }

  const existing = await getExtras(propertyId);
  const prev = existing.find((e) => e.id === id);
  const finalId = id || crypto.randomUUID();

  // Image: keep the current one unless "remove" is ticked or a new file replaces it.
  let image = form.get("removeImage") != null ? undefined : prev?.image;
  const upload = form.getAll("image").find((f): f is File => f instanceof File && f.size > 0);
  if (upload) {
    try {
      image = await uploadExtraImage(propertyId, finalId, upload);
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Image upload failed.", values };
    }
  }

  const extra: Extra = {
    id: finalId,
    name,
    desc,
    image,
    unit,
    price: configurable ? undefined : price,
    options: configurable ? options : undefined,
    fields: fields.length ? fields : undefined,
    infoTitle: fields.length ? infoTitle : undefined,
    scope,
    excludeRooms: excludeRooms.length ? excludeRooms : undefined,
    excludeRates: excludeRates.length ? excludeRates : undefined,
    taxable,
    active,
    position: prev?.position ?? existing.length,
    createdAt: prev?.createdAt ?? new Date().toISOString(),
  };
  await saveExtra(propertyId, extra);
  return redirect("/admin/extras");
}

export function meta() {
  return [{ title: "Admin · Extras" }];
}

function priceSummary(e: Extra, currency: string, t: AdminT): string {
  if (isConfigurable(e)) {
    const from = Math.min(...e.options!.map((o) => o.price));
    const key = e.options!.length === 1 ? "exOptionsFrom_one" : "exOptionsFrom_other";
    return t(key, { n: e.options!.length, price: formatMoney(from, currency), unit: UNIT_LABEL[e.unit] });
  }
  return `${formatMoney(e.price ?? 0, currency)} ${UNIT_LABEL[e.unit]}`;
}

/** Render an extra's options back to the editable one-per-line text. */
function optionsToText(e: Extra | null): string {
  if (!e?.options?.length) return "";
  return e.options
    .map((o) => [o.name, o.price, o.unit ?? "", o.desc ?? ""].filter((p, i) => i < 2 || p !== "").join(" | "))
    .join("\n");
}
function fieldsToText(e: Extra | null): string {
  if (!e?.fields?.length) return "";
  return e.fields.map((f) => `${f.required ? "*" : ""}${f.label}${f.placeholder ? ` | ${f.placeholder}` : ""}`).join("\n");
}

export default function AdminExtras({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const t = useAdminT();
  const saving = nav.state === "submitting";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("exTitle")}</h1>
        <p className="text-[15px] text-secondary">{t("exAddPropertyFirst")}</p>
      </div>
    );
  }

  const { extras, currency, editing, creating, rooms, rates } = loaderData;
  const v = actionData && "values" in actionData ? actionData.values : undefined;
  const cur = (k: keyof NonNullable<typeof v>, fallback = "") => (v?.[k] as string | undefined) ?? fallback;
  const checkbox = "h-4 w-4 rounded border-line-alt text-accent focus:ring-accent";
  // Show the form for the first extra, when editing, or when "New extra" was
  // clicked. Otherwise (extras already exist) show an "Add extra" button instead.
  const showForm = !!editing || creating || extras.length === 0;

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">{t("exTitle")}</h1>
      <p className="mb-6 text-[14px] text-muted">
        {t("exIntro1")} <strong>{t("exIntroSimple")}</strong> {t("exIntro2")}{" "}
        <strong>{t("exIntroOptions")}</strong> {t("exIntro3")}{" "}
        <strong>{t("exIntroFields")}</strong> {t("exIntro4")}
      </p>

      {!showForm && (
        <div className="mb-7">
          <Link
            to="/admin/extras?new=1"
            className="inline-block rounded-[10px] bg-accent px-5 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep"
          >
            {t("exNewExtraCta")}
          </Link>
        </div>
      )}

      {showForm && (
      <Form
        method="post"
        encType="multipart/form-data"
        key={editing?.id ?? "new"}
        className="mb-7 flex flex-col gap-4 rounded-[14px] border border-line bg-surface p-6"
      >
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="id" defaultValue={editing?.id ?? cur("id")} />

        <div className="flex items-center justify-between">
          <h2 className="font-serif text-[18px] font-semibold">{editing ? t("exEditExtra") : t("exNewExtra")}</h2>
          {(editing || creating) && (
            <Link to="/admin/extras" className="text-[13px] font-semibold text-muted hover:text-accent">
              {t("exCancel")}
            </Link>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block text-[13px] font-semibold text-secondary">
            {t("exName")}
            <input name="name" defaultValue={editing?.name ?? cur("name")} placeholder={t("exNamePlaceholder")} className={FIELD_INPUT} />
          </label>
          <label className="block text-[13px] font-semibold text-secondary">
            {t("exCharged")}
            <select name="unit" defaultValue={editing?.unit ?? cur("unit", "stay")} className={FIELD_INPUT}>
              {UNITS.map((u) => (
                <option key={u} value={u}>{UNIT_LABEL[u]}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="block text-[13px] font-semibold text-secondary">
          {t("exDescription")} <span className="font-normal text-faint">{t("exOptional")}</span>
          <textarea
            name="desc"
            rows={2}
            defaultValue={editing?.desc ?? cur("desc")}
            placeholder={t("exDescPlaceholder")}
            className={`${FIELD_INPUT} resize-y`}
          />
        </label>

        <div className="text-[13px] font-semibold text-secondary">
          {t("exPhoto")} <span className="font-normal text-faint">{t("exPhotoHint")}</span>
          <div className="mt-1.5 flex items-start gap-4">
            {editing?.image && (
              <div className="flex flex-none flex-col items-center gap-1.5">
                <img
                  src={editing.image}
                  alt=""
                  className="h-[72px] w-[104px] flex-none rounded-[10px] border border-line object-cover"
                />
                <label className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
                  <input type="checkbox" name="removeImage" className={checkbox} />
                  {t("exRemove")}
                </label>
              </div>
            )}
            <FilePicker name="image" accept="image/*" />
          </div>
          <span className="mt-1 block text-[11px] font-normal text-faint">
            {editing?.image ? t("exReplaceHint") : t("exImageFormats")}
          </span>
        </div>

        <label className="block text-[13px] font-semibold text-secondary">
          {t("exPrice")} <span className="font-normal text-faint">{t("exPriceHint")}</span>
          <input
            name="price"
            type="number"
            min={0}
            step="0.01"
            defaultValue={cur("price", editing && editing.price != null ? String(editing.price) : "")}
            placeholder="24"
            className={FIELD_INPUT}
          />
        </label>

        <label className="block text-[13px] font-semibold text-secondary">
          {t("exOptions")} <span className="font-normal text-faint">{t("exOptionsSubtitle")}</span>
          <textarea
            name="options"
            rows={3}
            defaultValue={cur("options", optionsToText(editing))}
            placeholder={t("exOptionsPlaceholder")}
            className={`${FIELD_INPUT} resize-y font-mono text-[13px]`}
          />
          <span className="mt-1 block text-[11px] font-normal text-faint">
            {t("exFormat")} <code>Name | price | unit | description</code>
            {t("exOptionsFormatSuffix", { unit: UNIT_LABEL[editing?.unit ?? "stay"] })}
          </span>
        </label>

        <label className="block text-[13px] font-semibold text-secondary">
          {t("exInfoToCollect")} <span className="font-normal text-faint">{t("exFieldsSubtitle")}</span>
          <textarea
            name="fields"
            rows={2}
            defaultValue={cur("fields", fieldsToText(editing))}
            placeholder={t("exFieldsPlaceholder")}
            className={`${FIELD_INPUT} resize-y font-mono text-[13px]`}
          />
          <span className="mt-1 block text-[11px] font-normal text-faint">
            {t("exFormat")} <code>Label | placeholder</code>
            {t("exFieldsFormatMid")} <code>*</code> {t("exFieldsFormatSuffix")}
          </span>
        </label>

        <label className="block text-[13px] font-semibold text-secondary">
          {t("exInfoHeading")} <span className="font-normal text-faint">{t("exOptional")}</span>
          <input name="infoTitle" defaultValue={editing?.infoTitle ?? cur("infoTitle")} placeholder={t("exInfoHeadingPlaceholder")} className={FIELD_INPUT} />
        </label>

        <fieldset className="rounded-[12px] border border-line bg-surface-alt/40 p-4">
          <legend className="px-1 text-[13px] font-semibold text-secondary">{t("exWhereOffered")}</legend>
          <label className="block text-[13px] font-semibold text-secondary">
            {t("exOffered")}
            <select name="scope" defaultValue={editing ? scopeOf(editing) : "room"} className={FIELD_INPUT}>
              <option value="room">{t("exScopeRoom")}</option>
              <option value="booking">{t("exScopeBooking")}</option>
            </select>
            <span className="mt-1 block text-[11px] font-normal text-faint">
              {t("exScopeHint")}
            </span>
          </label>

          {(rooms.length > 0 || rates.length > 0) && (
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {rooms.length > 0 && (
                <div>
                  <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-2">
                    {t("exHideForRooms")}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {rooms.map((r) => (
                      <label key={r.id} className="flex items-center gap-2 text-[13.5px] font-medium text-secondary">
                        <input
                          type="checkbox"
                          name="excludeRooms"
                          value={r.id}
                          defaultChecked={editing?.excludeRooms?.includes(r.id) ?? false}
                          className={checkbox}
                        />
                        {r.title}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {rates.length > 0 && (
                <div>
                  <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-2">
                    {t("exHideForRates")}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {rates.map((r) => (
                      <label key={r.id} className="flex items-center gap-2 text-[13.5px] font-medium text-secondary">
                        <input
                          type="checkbox"
                          name="excludeRates"
                          value={r.id}
                          defaultChecked={editing?.excludeRates?.includes(r.id) ?? false}
                          className={checkbox}
                        />
                        {r.title}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <span className="text-[11px] font-normal text-faint sm:col-span-2">
                {t("exExclusionsHint")}
              </span>
            </div>
          )}
        </fieldset>

        <label className="flex items-center gap-2.5 text-[14px] font-semibold">
          <input type="checkbox" name="taxable" defaultChecked={editing ? editing.taxable !== false : true} className={checkbox} />
          {t("exVatApplies")} <span className="font-normal text-faint">{t("exVatHint")}</span>
        </label>

        <label className="flex items-center gap-2.5 text-[14px] font-semibold">
          <input type="checkbox" name="active" defaultChecked={editing ? editing.active : true} className={checkbox} />
          {t("exActiveShown")}
        </label>

        {actionData && "error" in actionData && actionData.error && (
          <p className="text-[13px] text-red-600">{actionData.error}</p>
        )}
        <div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? t("saving") : editing ? t("exSaveExtra") : t("exAddExtra")}
          </button>
        </div>
      </Form>
      )}

      {extras.length === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-6 text-[14px] text-secondary">
          {t("exNoExtras")}
        </div>
      ) : (
        <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
          {extras.map((e, i) => (
            <div
              key={e.id}
              className={`flex items-center justify-between gap-4 px-5 py-4 ${i > 0 ? "border-t border-divider" : ""}`}
            >
              <div className="flex min-w-0 items-center gap-3.5">
                {e.image ? (
                  <img src={e.image} alt="" className="h-11 w-16 flex-none rounded-[8px] border border-line object-cover" />
                ) : (
                  <div className="h-11 w-16 flex-none rounded-[8px] border border-line" style={{ background: "repeating-linear-gradient(135deg,#efe7da,#efe7da 8px,#e7ddcc 8px,#e7ddcc 16px)" }} />
                )}
                <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <span className="font-semibold">{e.name}</span>
                  {e.active ? (
                    <span className="rounded-full bg-[#e8f0e6] px-2 py-0.5 text-[11px] font-semibold text-[#3f7a52]">{t("exActive")}</span>
                  ) : (
                    <span className="rounded-full bg-surface-alt px-2 py-0.5 text-[11px] font-semibold text-muted-2">{t("exHidden")}</span>
                  )}
                  {e.fields?.length ? (
                    <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-muted">{t("exCollectsInfo")}</span>
                  ) : null}
                  {scopeOf(e) === "booking" ? (
                    <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-muted">{t("exPerBooking")}</span>
                  ) : (e.excludeRooms?.length || e.excludeRates?.length) ? (
                    <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-muted">{t("exLimitedRoomsRates")}</span>
                  ) : null}
                  {e.taxable === false ? (
                    <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-muted">{t("exVatExempt")}</span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-[12.5px] text-muted-2">{priceSummary(e, currency, t)}</div>
                </div>
              </div>
              <div className="flex flex-none items-center gap-3">
                <Form method="post">
                  <input type="hidden" name="id" value={e.id} />
                  <button type="submit" name="intent" value="toggle" className="text-[13px] font-semibold text-muted hover:text-accent">
                    {e.active ? t("exHideAction") : t("exShowAction")}
                  </button>
                </Form>
                <Link to={`/admin/extras?edit=${e.id}`} className="text-[13px] font-semibold text-accent hover:underline">
                  {t("exEdit")}
                </Link>
                <Form method="post" onSubmit={(ev) => { if (!confirm(t("exDeleteConfirm", { name: e.name }))) ev.preventDefault(); }}>
                  <input type="hidden" name="id" value={e.id} />
                  <button type="submit" name="intent" value="delete" className="text-[13px] font-semibold text-[#c0392b] hover:underline">
                    {t("exDelete")}
                  </button>
                </Form>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
