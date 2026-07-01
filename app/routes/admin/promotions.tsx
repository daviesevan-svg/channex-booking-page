import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/promotions";
import { FIELD_INPUT } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getSettings } from "~/lib/overrides.server";
import { formatMoney } from "~/lib/money";
import {
  normalizeCode,
  type DiscountType,
  type PromoConditions,
  type PromoTrigger,
  type Promotion,
} from "~/lib/promotions";
import {
  deletePromotion,
  getPromotions,
  savePromotion,
  togglePromotion,
} from "~/lib/promotions.server";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const [promotions, settings] = await Promise.all([getPromotions(propertyId), getSettings(propertyId)]);
  const url = new URL(request.url);
  const editId = url.searchParams.get("edit");
  return {
    configured: true as const,
    promotions,
    currency: settings.currency || "GBP",
    editing: promotions.find((p) => p.id === editId) ?? null,
    creating: url.searchParams.get("new") != null,
  };
}

const posInt = (v: FormDataEntryValue | null): number | undefined => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "delete") {
    await deletePromotion(propertyId, String(form.get("id")));
    await queueGoogleAriPush(propertyId, ["promotions"]);
    return redirect("/admin/promotions");
  }
  if (intent === "toggle") {
    await togglePromotion(propertyId, String(form.get("id")));
    await queueGoogleAriPush(propertyId, ["promotions"]);
    return redirect("/admin/promotions");
  }

  // intent === "save"
  const id = String(form.get("id") || "").trim();
  const trigger: PromoTrigger = form.get("trigger") === "auto" ? "auto" : "code";
  const code = normalizeCode(String(form.get("code") ?? ""));
  const name = String(form.get("name") ?? "").trim();
  const value = Number(form.get("value"));
  const enabled = form.get("enabled") != null;
  // Automatic offers are percent-only (so the % can be shown per-room while browsing).
  const type = (trigger === "auto"
    ? "percent"
    : String(form.get("type")) === "fixed"
      ? "fixed"
      : "percent") as DiscountType;
  const values = {
    id,
    trigger,
    code,
    name,
    type,
    value: form.get("value") as string,
    minDaysAhead: String(form.get("minDaysAhead") ?? ""),
    maxDaysAhead: String(form.get("maxDaysAhead") ?? ""),
    minNights: String(form.get("minNights") ?? ""),
    stayFrom: String(form.get("stayFrom") ?? ""),
    stayTo: String(form.get("stayTo") ?? ""),
  };

  if (!Number.isFinite(value) || value <= 0) return { error: "Enter a discount greater than 0.", values };
  if (type === "percent" && value > 100) return { error: "A percentage can’t be more than 100.", values };

  const existing = await getPromotions(propertyId);
  let conditions: PromoConditions | undefined;

  if (trigger === "code") {
    if (!code) return { error: "Enter a promo code.", values };
    const clash = existing.find((p) => p.trigger === "code" && p.code === code && p.id !== id);
    if (clash) return { error: `The code “${code}” is already used by another promotion.`, values };
  } else {
    if (!name) return { error: "Give the offer a name guests will see (e.g. “Early Bird”).", values };
    const minDaysAhead = posInt(form.get("minDaysAhead"));
    const maxDaysAhead = posInt(form.get("maxDaysAhead"));
    const minNights = posInt(form.get("minNights"));
    const isoDate = (val: FormDataEntryValue | null) => {
      const s = String(val ?? "").trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
    };
    const stayFrom = isoDate(form.get("stayFrom"));
    const stayTo = isoDate(form.get("stayTo"));
    if (minDaysAhead != null && maxDaysAhead != null && minDaysAhead > maxDaysAhead) {
      return { error: "“Book at least … days ahead” can’t be more than “…at most”.", values };
    }
    if (stayFrom && stayTo && stayFrom > stayTo) {
      return { error: "“Check-in on or after” can’t be later than “Check-out on or before”.", values };
    }
    conditions = { minDaysAhead, maxDaysAhead, minNights, stayFrom, stayTo };
  }

  const prev = existing.find((p) => p.id === id);
  const promo: Promotion = {
    id: id || crypto.randomUUID(),
    trigger,
    code: trigger === "code" ? code : "",
    name: name || undefined,
    conditions: trigger === "auto" ? conditions : undefined,
    type,
    value: type === "percent" ? Math.round(value) : Math.round(value * 100) / 100,
    enabled,
    createdAt: prev?.createdAt ?? new Date().toISOString(),
  };
  await savePromotion(propertyId, promo);
  await queueGoogleAriPush(propertyId, ["promotions"]);
  return redirect("/admin/promotions");
}

export function meta() {
  return [{ title: "Admin · Promotions" }];
}

function discountSummary(p: Promotion, currency: string): string {
  return p.type === "percent" ? `${p.value}% off` : `${formatMoney(p.value, currency)} off`;
}

/** Human-readable list of an automatic offer's conditions. */
function conditionSummary(c?: PromoConditions): string {
  if (!c) return "Always on";
  const parts: string[] = [];
  if (c.minDaysAhead != null) parts.push(`book ${c.minDaysAhead}+ days ahead`);
  if (c.maxDaysAhead != null) parts.push(`book within ${c.maxDaysAhead} days`);
  if (c.minNights != null) parts.push(`${c.minNights}+ nights`);
  if (c.stayFrom || c.stayTo) parts.push(`stay ${c.stayFrom ?? "…"} → ${c.stayTo ?? "…"}`);
  return parts.length ? parts.join(" · ") : "Always on";
}

export default function AdminPromotions({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Promotions</h1>
        <p className="text-[15px] text-secondary">
          Set <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code> to create
          promotions.
        </p>
      </div>
    );
  }

  const { promotions, currency, editing, creating } = loaderData;
  const v = actionData && "values" in actionData ? actionData.values : undefined;
  const cur = (k: keyof NonNullable<typeof v>, fallback = "") => (v?.[k] as string | undefined) ?? fallback;
  const checkbox = "h-4 w-4 rounded border-line-alt text-accent focus:ring-accent";
  // Show the form for the first promotion, when editing, or when "New
  // promotion" was clicked. Otherwise show an "Add promotion" button instead.
  const showForm = !!editing || creating || promotions.length === 0;

  const [trigger, setTrigger] = useState<PromoTrigger>(
    (v?.trigger as PromoTrigger) ?? editing?.trigger ?? "code",
  );
  const [type, setType] = useState<DiscountType>((v?.type as DiscountType) ?? editing?.type ?? "percent");
  const isAuto = trigger === "auto";

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">Promotions</h1>
      <p className="mb-6 text-[14px] text-muted">
        Two kinds: a <strong>code</strong> guests type at checkout, or an <strong>automatic offer</strong>{" "}
        that applies with no code when its rules match (e.g. an early-bird discount). Automatic
        offers show their discounted price as guests browse.
      </p>

      {!showForm && (
        <div className="mb-7">
          <Link
            to="/admin/promotions?new=1"
            className="inline-block rounded-[10px] bg-accent px-5 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep"
          >
            + New promotion
          </Link>
        </div>
      )}

      {/* create / edit form */}
      {showForm && (
      <Form
        method="post"
        key={editing?.id ?? "new"}
        className="mb-7 flex flex-col gap-4 rounded-[14px] border border-line bg-surface p-6"
      >
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="id" defaultValue={editing?.id ?? cur("id")} />

        <div className="flex items-center justify-between">
          <h2 className="font-serif text-[18px] font-semibold">
            {editing ? "Edit promotion" : "New promotion"}
          </h2>
          {(editing || creating) && (
            <Link to="/admin/promotions" className="text-[13px] font-semibold text-muted hover:text-accent">
              Cancel
            </Link>
          )}
        </div>

        {/* trigger */}
        <div className="flex flex-wrap gap-2">
          {(["code", "auto"] as PromoTrigger[]).map((t) => (
            <label
              key={t}
              className={`cursor-pointer rounded-[10px] border px-4 py-2.5 text-[13.5px] font-semibold ${
                trigger === t ? "border-accent bg-accent-soft text-accent-deep" : "border-line-alt text-muted"
              }`}
            >
              <input
                type="radio"
                name="trigger"
                value={t}
                checked={trigger === t}
                onChange={() => setTrigger(t)}
                className="sr-only"
              />
              {t === "code" ? "Promo code" : "Automatic offer"}
            </label>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {!isAuto && (
            <label className="block text-[13px] font-semibold text-secondary">
              Promo code
              <input
                name="code"
                defaultValue={editing?.code ?? cur("code")}
                placeholder="SUMMER10"
                autoComplete="off"
                className={`${FIELD_INPUT} uppercase`}
              />
            </label>
          )}
          <label className="block text-[13px] font-semibold text-secondary">
            Name{" "}
            <span className="font-normal text-faint">
              {isAuto ? "(shown to guests)" : "(optional, internal)"}
            </span>
            <input
              name="name"
              defaultValue={editing?.name ?? cur("name")}
              placeholder={isAuto ? "Early Bird" : "Summer sale"}
              className={FIELD_INPUT}
            />
          </label>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {!isAuto && (
            <label className="block text-[13px] font-semibold text-secondary">
              Discount type
              <select
                name="type"
                value={type}
                onChange={(e) => setType(e.target.value as DiscountType)}
                className={FIELD_INPUT}
              >
                <option value="percent">Percentage off</option>
                <option value="fixed">Fixed amount off</option>
              </select>
            </label>
          )}
          <label className="block text-[13px] font-semibold text-secondary">
            {isAuto || type === "percent" ? "Percentage off" : "Amount off"}
            <input
              name="value"
              type="number"
              min={0}
              step={isAuto || type === "percent" ? 1 : "any"}
              defaultValue={cur("value", editing ? String(editing.value) : "")}
              placeholder={isAuto || type === "percent" ? "10" : "20"}
              className={FIELD_INPUT}
            />
            <span className="mt-1 block text-[11px] font-normal text-faint">
              {isAuto || type === "percent" ? "1–100." : `Fixed amount in ${currency}.`}
            </span>
          </label>
        </div>

        {isAuto && (
          <div className="rounded-[12px] border border-line bg-surface-alt/40 p-4">
            <div className="mb-1 text-[13px] font-semibold text-secondary">Rules</div>
            <p className="mb-3 text-[12px] text-faint">
              The offer applies when every rule you set is met. Leave a field blank to ignore it.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <label className="block text-[12.5px] font-semibold text-secondary">
                Book at least … days ahead
                <input
                  name="minDaysAhead"
                  type="number"
                  min={0}
                  defaultValue={cur("minDaysAhead", editing?.conditions?.minDaysAhead?.toString() ?? "")}
                  placeholder="60"
                  className={FIELD_INPUT}
                />
                <span className="mt-1 block text-[11px] font-normal text-faint">Early bird</span>
              </label>
              <label className="block text-[12.5px] font-semibold text-secondary">
                …or at most … days ahead
                <input
                  name="maxDaysAhead"
                  type="number"
                  min={0}
                  defaultValue={cur("maxDaysAhead", editing?.conditions?.maxDaysAhead?.toString() ?? "")}
                  placeholder="7"
                  className={FIELD_INPUT}
                />
                <span className="mt-1 block text-[11px] font-normal text-faint">Last minute</span>
              </label>
              <label className="block text-[12.5px] font-semibold text-secondary">
                Stay of at least … nights
                <input
                  name="minNights"
                  type="number"
                  min={0}
                  defaultValue={cur("minNights", editing?.conditions?.minNights?.toString() ?? "")}
                  placeholder="7"
                  className={FIELD_INPUT}
                />
                <span className="mt-1 block text-[11px] font-normal text-faint">Length of stay</span>
              </label>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block text-[12.5px] font-semibold text-secondary">
                Check-in on or after
                <input
                  name="stayFrom"
                  type="date"
                  defaultValue={cur("stayFrom", editing?.conditions?.stayFrom ?? "")}
                  className={FIELD_INPUT}
                />
              </label>
              <label className="block text-[12.5px] font-semibold text-secondary">
                Check-out on or before
                <input
                  name="stayTo"
                  type="date"
                  defaultValue={cur("stayTo", editing?.conditions?.stayTo ?? "")}
                  className={FIELD_INPUT}
                />
                <span className="mt-1 block text-[11px] font-normal text-faint">
                  Date window — e.g. a low-season sale
                </span>
              </label>
            </div>
          </div>
        )}

        <label className="flex items-center gap-2.5 text-[14px] font-semibold">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={editing ? editing.enabled : true}
            className={checkbox}
          />
          Active
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
            {saving ? "Saving…" : editing ? "Save promotion" : "Add promotion"}
          </button>
        </div>
      </Form>
      )}

      {/* list */}
      {promotions.length === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-6 text-[14px] text-secondary">
          No promotions yet. Create one above.
        </div>
      ) : (
        <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
          {promotions.map((p, i) => (
            <div
              key={p.id}
              className={`flex items-center justify-between gap-4 px-5 py-4 ${
                i > 0 ? "border-t border-divider" : ""
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  {p.trigger === "code" ? (
                    <span className="font-mono text-[14px] font-semibold">{p.code}</span>
                  ) : (
                    <span className="text-[14px] font-semibold">{p.name || "Offer"}</span>
                  )}
                  {p.trigger === "auto" && (
                    <span className="rounded-full bg-[#ece6f0] px-2 py-0.5 text-[11px] font-semibold text-[#6b4f8a]">
                      Automatic
                    </span>
                  )}
                  {p.enabled ? (
                    <span className="rounded-full bg-[#e8f0e6] px-2 py-0.5 text-[11px] font-semibold text-[#3f7a52]">
                      Active
                    </span>
                  ) : (
                    <span className="rounded-full bg-surface-alt px-2 py-0.5 text-[11px] font-semibold text-muted-2">
                      Disabled
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[12.5px] text-muted-2">
                  {discountSummary(p, currency)}
                  {p.trigger === "auto"
                    ? ` · ${conditionSummary(p.conditions)}`
                    : p.name
                      ? ` · ${p.name}`
                      : ""}
                </div>
              </div>
              <div className="flex flex-none items-center gap-3">
                <Form method="post">
                  <input type="hidden" name="id" value={p.id} />
                  <button
                    type="submit"
                    name="intent"
                    value="toggle"
                    className="text-[13px] font-semibold text-muted hover:text-accent"
                  >
                    {p.enabled ? "Disable" : "Enable"}
                  </button>
                </Form>
                <Link
                  to={`/admin/promotions?edit=${p.id}`}
                  className="text-[13px] font-semibold text-accent hover:underline"
                >
                  Edit
                </Link>
                <Form
                  method="post"
                  onSubmit={(e) => {
                    if (!confirm(`Delete ${p.trigger === "code" ? `promo code ${p.code}` : p.name || "this offer"}?`))
                      e.preventDefault();
                  }}
                >
                  <input type="hidden" name="id" value={p.id} />
                  <button
                    type="submit"
                    name="intent"
                    value="delete"
                    className="text-[13px] font-semibold text-[#c0392b] hover:underline"
                  >
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
