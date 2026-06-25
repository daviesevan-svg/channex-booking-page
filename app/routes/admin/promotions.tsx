import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/promotions";
import { FIELD_INPUT } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getSettings } from "~/lib/overrides.server";
import { formatMoney } from "~/lib/money";
import { normalizeCode, type DiscountType, type Promotion } from "~/lib/promotions";
import {
  deletePromotion,
  getPromotions,
  savePromotion,
  togglePromotion,
} from "~/lib/promotions.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const [promotions, settings] = await Promise.all([getPromotions(propertyId), getSettings(propertyId)]);
  const editId = new URL(request.url).searchParams.get("edit");
  return {
    configured: true as const,
    promotions,
    currency: settings.currency || "GBP",
    editing: promotions.find((p) => p.id === editId) ?? null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "delete") {
    await deletePromotion(propertyId, String(form.get("id")));
    return redirect("/admin/promotions");
  }
  if (intent === "toggle") {
    await togglePromotion(propertyId, String(form.get("id")));
    return redirect("/admin/promotions");
  }

  // intent === "save"
  const id = String(form.get("id") || "").trim();
  const code = normalizeCode(String(form.get("code") ?? ""));
  const name = String(form.get("name") ?? "").trim();
  const type = (String(form.get("type")) === "fixed" ? "fixed" : "percent") as DiscountType;
  const value = Number(form.get("value"));
  const enabled = form.get("enabled") != null;
  const values = { id, code, name, type, value: form.get("value") as string };

  if (!code) return { error: "Enter a promo code.", values };
  if (!Number.isFinite(value) || value <= 0) return { error: "Enter a discount greater than 0.", values };
  if (type === "percent" && value > 100) return { error: "A percentage can’t be more than 100.", values };

  const existing = await getPromotions(propertyId);
  const clash = existing.find((p) => p.code === code && p.id !== id);
  if (clash) return { error: `The code “${code}” is already used by another promotion.`, values };

  const prev = existing.find((p) => p.id === id);
  const promo: Promotion = {
    id: id || crypto.randomUUID(),
    code,
    name: name || undefined,
    type,
    value: type === "percent" ? Math.round(value) : Math.round(value * 100) / 100,
    enabled,
    createdAt: prev?.createdAt ?? new Date().toISOString(),
  };
  await savePromotion(propertyId, promo);
  return redirect("/admin/promotions");
}

export function meta() {
  return [{ title: "Admin · Promotions" }];
}

function summary(p: Promotion, currency: string): string {
  return p.type === "percent" ? `${p.value}% off` : `${formatMoney(p.value, currency)} off`;
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

  const { promotions, currency, editing } = loaderData;
  const v = actionData && "values" in actionData ? actionData.values : undefined;
  const cur = (k: keyof NonNullable<typeof v>, fallback = "") =>
    (v?.[k] as string | undefined) ?? fallback;
  const type = (v?.type ?? editing?.type ?? "percent") as DiscountType;
  const checkbox = "h-4 w-4 rounded border-line-alt text-accent focus:ring-accent";

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">Promotions</h1>
      <p className="mb-6 text-[14px] text-muted">
        Create a code guests can enter at checkout for a percentage or fixed amount off their
        booking total.
      </p>

      {/* create / edit form */}
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
          {editing && (
            <Link to="/admin/promotions" className="text-[13px] font-semibold text-muted hover:text-accent">
              Cancel edit
            </Link>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
          <label className="block text-[13px] font-semibold text-secondary">
            Name <span className="font-normal text-faint">(optional, internal)</span>
            <input
              name="name"
              defaultValue={editing?.name ?? cur("name")}
              placeholder="Summer sale"
              className={FIELD_INPUT}
            />
          </label>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block text-[13px] font-semibold text-secondary">
            Discount type
            <select name="type" defaultValue={type} className={FIELD_INPUT}>
              <option value="percent">Percentage off</option>
              <option value="fixed">Fixed amount off</option>
            </select>
          </label>
          <label className="block text-[13px] font-semibold text-secondary">
            Discount value
            <input
              name="value"
              type="number"
              min={0}
              step="any"
              defaultValue={cur("value", editing ? String(editing.value) : "")}
              placeholder={type === "fixed" ? "20" : "10"}
              className={FIELD_INPUT}
            />
            <span className="mt-1 block text-[11px] font-normal text-faint">
              Percentage (1–100), or a fixed amount in {currency}.
            </span>
          </label>
        </div>

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
                  <span className="font-mono text-[14px] font-semibold">{p.code}</span>
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
                  {summary(p, currency)}
                  {p.name ? ` · ${p.name}` : ""}
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
                    if (!confirm(`Delete promo code ${p.code}?`)) e.preventDefault();
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
