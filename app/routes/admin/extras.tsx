import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/extras";
import { FIELD_INPUT } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getSettings } from "~/lib/overrides.server";
import { formatMoney } from "~/lib/money";
import {
  UNIT_LABEL,
  isConfigurable,
  type Extra,
  type ExtraField,
  type ExtraOption,
  type ExtraUnit,
} from "~/lib/extras";
import { deleteExtra, ensureExampleExtras, getExtras, saveExtra, toggleExtra } from "~/lib/extras.server";

const UNITS: ExtraUnit[] = ["stay", "night", "person", "trip"];

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
  const [extras, settings] = await Promise.all([getExtras(propertyId), getSettings(propertyId)]);
  const url = new URL(request.url);
  const editId = url.searchParams.get("edit");
  return {
    configured: true as const,
    extras,
    currency: settings.currency || "GBP",
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
  const extra: Extra = {
    id: id || crypto.randomUUID(),
    name,
    desc,
    unit,
    price: configurable ? undefined : price,
    options: configurable ? options : undefined,
    fields: fields.length ? fields : undefined,
    infoTitle: fields.length ? infoTitle : undefined,
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

function priceSummary(e: Extra, currency: string): string {
  if (isConfigurable(e)) {
    const from = Math.min(...e.options!.map((o) => o.price));
    return `${e.options!.length} options · from ${formatMoney(from, currency)} ${UNIT_LABEL[e.unit]}`;
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
  const saving = nav.state === "submitting";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Extras</h1>
        <p className="text-[15px] text-secondary">Add a property first to manage its extras.</p>
      </div>
    );
  }

  const { extras, currency, editing, creating } = loaderData;
  const v = actionData && "values" in actionData ? actionData.values : undefined;
  const cur = (k: keyof NonNullable<typeof v>, fallback = "") => (v?.[k] as string | undefined) ?? fallback;
  const checkbox = "h-4 w-4 rounded border-line-alt text-accent focus:ring-accent";
  // Show the form for the first extra, when editing, or when "New extra" was
  // clicked. Otherwise (extras already exist) show an "Add extra" button instead.
  const showForm = !!editing || creating || extras.length === 0;

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">Extras</h1>
      <p className="mb-6 text-[14px] text-muted">
        Add-ons guests can buy on the “Enhance your stay” step — breakfast, airport pickup, spa, and
        so on. A <strong>simple</strong> extra has one price; add <strong>options</strong> to let
        guests choose (e.g. vehicle type), and <strong>info fields</strong> to collect details.
      </p>

      {!showForm && (
        <div className="mb-7">
          <Link
            to="/admin/extras?new=1"
            className="inline-block rounded-[10px] bg-accent px-5 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep"
          >
            + New extra
          </Link>
        </div>
      )}

      {showForm && (
      <Form
        method="post"
        key={editing?.id ?? "new"}
        className="mb-7 flex flex-col gap-4 rounded-[14px] border border-line bg-surface p-6"
      >
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="id" defaultValue={editing?.id ?? cur("id")} />

        <div className="flex items-center justify-between">
          <h2 className="font-serif text-[18px] font-semibold">{editing ? "Edit extra" : "New extra"}</h2>
          {(editing || creating) && (
            <Link to="/admin/extras" className="text-[13px] font-semibold text-muted hover:text-accent">
              Cancel
            </Link>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block text-[13px] font-semibold text-secondary">
            Name
            <input name="name" defaultValue={editing?.name ?? cur("name")} placeholder="Airport pickup" className={FIELD_INPUT} />
          </label>
          <label className="block text-[13px] font-semibold text-secondary">
            Charged
            <select name="unit" defaultValue={editing?.unit ?? cur("unit", "stay")} className={FIELD_INPUT}>
              {UNITS.map((u) => (
                <option key={u} value={u}>{UNIT_LABEL[u]}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="block text-[13px] font-semibold text-secondary">
          Description <span className="font-normal text-faint">(optional)</span>
          <textarea
            name="desc"
            rows={2}
            defaultValue={editing?.desc ?? cur("desc")}
            placeholder="Private door-to-door transfer with meet & greet."
            className={`${FIELD_INPUT} resize-y`}
          />
        </label>

        <label className="block text-[13px] font-semibold text-secondary">
          Price <span className="font-normal text-faint">(for a simple extra — leave blank if using options)</span>
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
          Options <span className="font-normal text-faint">(one per line — guests choose one)</span>
          <textarea
            name="options"
            rows={3}
            defaultValue={cur("options", optionsToText(editing))}
            placeholder={"Private car | 65 | Saloon, room for luggage\nPrivate van | 95 | Ideal for groups\nLuxury sedan | 120 | person | Premium Mercedes"}
            className={`${FIELD_INPUT} resize-y font-mono text-[13px]`}
          />
          <span className="mt-1 block text-[11px] font-normal text-faint">
            Format: <code>Name | price | unit | description</code>. Unit and description are optional;
            omit unit to use “{UNIT_LABEL[editing?.unit ?? "stay"]}”. Adding options makes the extra a
            choose-one popup and ignores the single price above.
          </span>
        </label>

        <label className="block text-[13px] font-semibold text-secondary">
          Info to collect <span className="font-normal text-faint">(one field per line, optional)</span>
          <textarea
            name="fields"
            rows={2}
            defaultValue={cur("fields", fieldsToText(editing))}
            placeholder={"*Flight number | e.g. EI 462\nExpected arrival time | e.g. 14:30"}
            className={`${FIELD_INPUT} resize-y font-mono text-[13px]`}
          />
          <span className="mt-1 block text-[11px] font-normal text-faint">
            Format: <code>Label | placeholder</code>. Prefix with <code>*</code> to make it required.
          </span>
        </label>

        <label className="block text-[13px] font-semibold text-secondary">
          Info section heading <span className="font-normal text-faint">(optional)</span>
          <input name="infoTitle" defaultValue={editing?.infoTitle ?? cur("infoTitle")} placeholder="Flight details" className={FIELD_INPUT} />
        </label>

        <label className="flex items-center gap-2.5 text-[14px] font-semibold">
          <input type="checkbox" name="active" defaultChecked={editing ? editing.active : true} className={checkbox} />
          Active (shown to guests)
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
            {saving ? "Saving…" : editing ? "Save extra" : "Add extra"}
          </button>
        </div>
      </Form>
      )}

      {extras.length === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-6 text-[14px] text-secondary">
          No extras yet. Create one above.
        </div>
      ) : (
        <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
          {extras.map((e, i) => (
            <div
              key={e.id}
              className={`flex items-center justify-between gap-4 px-5 py-4 ${i > 0 ? "border-t border-divider" : ""}`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <span className="font-semibold">{e.name}</span>
                  {e.active ? (
                    <span className="rounded-full bg-[#e8f0e6] px-2 py-0.5 text-[11px] font-semibold text-[#3f7a52]">Active</span>
                  ) : (
                    <span className="rounded-full bg-surface-alt px-2 py-0.5 text-[11px] font-semibold text-muted-2">Hidden</span>
                  )}
                  {e.fields?.length ? (
                    <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-muted">collects info</span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-[12.5px] text-muted-2">{priceSummary(e, currency)}</div>
              </div>
              <div className="flex flex-none items-center gap-3">
                <Form method="post">
                  <input type="hidden" name="id" value={e.id} />
                  <button type="submit" name="intent" value="toggle" className="text-[13px] font-semibold text-muted hover:text-accent">
                    {e.active ? "Hide" : "Show"}
                  </button>
                </Form>
                <Link to={`/admin/extras?edit=${e.id}`} className="text-[13px] font-semibold text-accent hover:underline">
                  Edit
                </Link>
                <Form method="post" onSubmit={(ev) => { if (!confirm(`Delete “${e.name}”?`)) ev.preventDefault(); }}>
                  <input type="hidden" name="id" value={e.id} />
                  <button type="submit" name="intent" value="delete" className="text-[13px] font-semibold text-[#c0392b] hover:underline">
                    Delete
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
