import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/rate";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { isDeadlineUnit } from "~/lib/content";
import { deleteRate, getRate, getRooms, saveRate, type CatalogRate } from "~/lib/catalog.server";
import { FIELD_INPUT } from "~/components/admin-form";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) throw redirect("/admin/rates");

  const rooms = await getRooms(propertyId);
  if (rooms.length === 0) throw redirect("/admin/rates");

  const isNew = params.rateId === "new";
  const rate = isNew ? null : await getRate(propertyId, params.rateId);
  if (!isNew && !rate) throw redirect("/admin/rates");
  return { isNew, rate, rooms: rooms.map((r) => ({ id: r.id, title: r.title })) };
}

export async function action({ params, request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };

  const form = await request.formData();
  const isNew = params.rateId === "new";

  if (form.get("intent") === "delete" && !isNew) {
    await deleteRate(propertyId, params.rateId);
    return redirect("/admin/rates");
  }

  const existing = isNew ? undefined : await getRate(propertyId, params.rateId);
  const title = String(form.get("title") ?? "").trim();
  if (!title) return { error: "Enter a rate name." };

  // One price per room — a room is offered this rate only when it has a price.
  const prices: Record<string, number> = {};
  const rooms = await getRooms(propertyId);
  for (const room of rooms) {
    const raw = form.get(`price:${room.id}`);
    if (raw == null || String(raw).trim() === "") continue;
    const p = Math.round(Number(raw) * 100) / 100;
    if (Number.isFinite(p) && p > 0) prices[room.id] = p;
  }
  if (Object.keys(prices).length === 0) {
    return { error: "Enter a nightly price for at least one room." };
  }

  const posInt = (v: FormDataEntryValue | null) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const unit = (v: FormDataEntryValue | null) => {
    const s = String(v ?? "");
    return isDeadlineUnit(s) ? s : undefined;
  };

  const rate: CatalogRate = {
    id: existing?.id ?? crypto.randomUUID(),
    title,
    mealPlan: String(form.get("mealPlan") ?? "").trim() || undefined,
    prices,
    refundable: form.get("refundable") != null,
    cancelDeadlineValue: posInt(form.get("cancelDeadlineValue")),
    cancelDeadlineUnit: unit(form.get("cancelDeadlineUnit")),
    cancellationNote: String(form.get("cancellationNote") ?? "").trim() || undefined,
    inclusions: String(form.get("inclusions") ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    active: form.get("active") != null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  await saveRate(propertyId, rate);
  return isNew ? redirect(`/admin/rates/${rate.id}`) : { ok: true };
}

export function meta() {
  return [{ title: "Admin · Rate" }];
}

export default function AdminRate({ loaderData, actionData }: Route.ComponentProps) {
  const { isNew, rate, rooms } = loaderData;
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const checkbox = "h-4 w-4 rounded border-line-alt text-accent focus:ring-accent";

  return (
    <div>
      <Link
        to="/admin/rates"
        className="mb-4 inline-block text-[13px] font-semibold text-muted hover:text-accent"
      >
        ← All rates
      </Link>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">{isNew ? "New rate" : rate?.title}</h1>
        {actionData && "ok" in actionData && actionData.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            ✓ Saved
          </span>
        )}
      </div>

      <Form method="post" className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <label className="block text-[13px] font-semibold text-secondary">
            Rate name
            <input name="title" defaultValue={rate?.title} placeholder="Breakfast Rate" className={FIELD_INPUT} />
          </label>
          <label className="block text-[13px] font-semibold text-secondary">
            Meal plan <span className="font-normal text-faint">(optional)</span>
            <input name="mealPlan" defaultValue={rate?.mealPlan} placeholder="Breakfast included" className={FIELD_INPUT} />
          </label>
        </div>

        <div className="border-t border-divider pt-5">
          <div className="mb-1 font-serif text-[17px] font-semibold">Nightly price per room</div>
          <p className="mb-3 text-[13px] text-muted">
            This rate applies to every room you price below — leave a room blank to not offer it
            there. Occupancy is taken from each room&rsquo;s settings. Prices in your property
            currency.
          </p>
          <div className="overflow-hidden rounded-[12px] border border-line">
            {rooms.map((r, i) => (
              <label
                key={r.id}
                className={`flex items-center justify-between gap-3 px-4 py-3 ${
                  i > 0 ? "border-t border-divider" : ""
                }`}
              >
                <span className="text-[14px] font-semibold text-secondary">{r.title}</span>
                <input
                  name={`price:${r.id}`}
                  type="number"
                  min={0}
                  step="0.01"
                  defaultValue={rate?.prices[r.id] ?? ""}
                  placeholder="—"
                  className="w-32 rounded-[10px] border border-line-alt bg-surface-alt px-3 py-2 text-right text-[15px] text-ink outline-none focus:border-accent"
                />
              </label>
            ))}
          </div>
        </div>

        <label className="block text-[13px] font-semibold text-secondary">
          What&rsquo;s included <span className="font-normal text-faint">(one per line)</span>
          <textarea
            name="inclusions"
            rows={3}
            defaultValue={rate?.inclusions.join("\n")}
            placeholder={"Breakfast for two\nFree cancellation\nFree Wi-Fi"}
            className={`${FIELD_INPUT} resize-y`}
          />
        </label>

        <div className="border-t border-divider pt-5">
          <div className="mb-3 font-serif text-[17px] font-semibold">Cancellation policy</div>
          <label className="mb-3 flex items-center gap-2.5 text-[14px] font-semibold">
            <input type="checkbox" name="refundable" defaultChecked={rate ? rate.refundable : true} className={checkbox} />
            Refundable (free cancellation)
          </label>
          <div className="text-[13px] font-semibold text-secondary">Free cancellation up to</div>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              name="cancelDeadlineValue"
              type="number"
              min={0}
              defaultValue={rate?.cancelDeadlineValue ?? ""}
              placeholder="24"
              className="w-24 rounded-[10px] border border-line-alt bg-surface-alt px-3 py-[10px] text-[15px] text-ink outline-none focus:border-accent"
            />
            <select
              name="cancelDeadlineUnit"
              defaultValue={rate?.cancelDeadlineUnit ?? "hours"}
              className="rounded-[10px] border border-line-alt bg-surface-alt px-3 py-[11px] text-[15px] text-ink outline-none focus:border-accent"
            >
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
            <span className="text-[13px] text-muted-2">before arrival</span>
          </div>
          <label className="mt-4 block text-[13px] font-semibold text-secondary">
            Cancellation note <span className="font-normal text-faint">(shown to guests, optional)</span>
            <input name="cancellationNote" defaultValue={rate?.cancellationNote} placeholder="Free cancellation up to 24h before arrival." className={FIELD_INPUT} />
          </label>
        </div>

        <label className="flex items-center gap-2.5 border-t border-divider pt-5 text-[14px] font-semibold">
          <input type="checkbox" name="active" defaultChecked={rate ? rate.active : true} className={checkbox} />
          Active (bookable by guests)
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
            {saving ? "Saving…" : isNew ? "Create rate" : "Save rate"}
          </button>
        </div>
      </Form>

      {!isNew && (
        <Form
          method="post"
          className="mt-4"
          onSubmit={(e) => {
            if (!confirm("Delete this rate?")) e.preventDefault();
          }}
        >
          <button type="submit" name="intent" value="delete" className="text-[13px] font-semibold text-[#c0392b] hover:underline">
            Delete rate
          </button>
        </Form>
      )}
    </div>
  );
}
