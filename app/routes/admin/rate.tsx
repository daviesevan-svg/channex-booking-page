import { useRef, useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/rate";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { isDeadlineUnit } from "~/lib/content";
import { deleteRate, getRate, getRooms, saveRate, type CatalogRate, type OccupancyPricing } from "~/lib/catalog.server";
import {
  CARD_HANDLINGS,
  CARD_HANDLING_LABEL,
  DEPOSIT_TYPES,
  DEPOSIT_TYPE_LABEL,
  PAYMENT_TIMINGS,
  PAYMENT_TIMING_LABEL,
  PENALTY_LABEL,
  PENALTY_TYPES,
  describePolicy,
  ratePolicyOf,
  type CancelTier,
  type RatePolicy,
} from "~/lib/rate-policy";
import { FIELD_INPUT } from "~/components/admin-form";

/** Build the structured policy from form field getters — shared by the save
 *  action and the editor's live preview. Disabled inputs simply read as "". */
function buildPolicy(get: (name: string) => string): RatePolicy {
  const num = (v: string) => {
    const n = Math.round(Number(v) * 100) / 100;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const int = (v: string) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const pick = <T extends string>(v: string, allowed: readonly T[], fb: T): T =>
    (allowed as readonly string[]).includes(v) ? (v as T) : fb;

  const refundable = get("refundable") !== "";
  const cdv = int(get("cancelDeadlineValue"));
  const rawUnit = get("cancelDeadlineUnit");
  const cdu = isDeadlineUnit(rawUnit) ? rawUnit : "hours";
  const latePenalty = pick(get("latePenalty"), PENALTY_TYPES, "full_stay");
  const tiers: CancelTier[] =
    refundable && cdv
      ? [
          {
            deadlineValue: cdv,
            deadlineUnit: cdu,
            penalty: latePenalty,
            penaltyValue: latePenalty === "percent" || latePenalty === "fixed" ? num(get("latePenaltyValue")) : undefined,
          },
        ]
      : [];
  const payTiming = pick(get("payTiming"), PAYMENT_TIMINGS, "pay_at_hotel");
  const depositValue = num(get("depositValue"));
  const noShowPenalty = pick(get("noShowPenalty"), PENALTY_TYPES, "first_night");
  return {
    payment: {
      timing: payTiming,
      card: pick(get("cardHandling"), CARD_HANDLINGS, "guarantee"),
      deposit: payTiming === "deposit" && depositValue ? { type: pick(get("depositType"), DEPOSIT_TYPES, "percent"), value: depositValue } : undefined,
    },
    cancellation: { refundable, tiers },
    noShow: {
      penalty: noShowPenalty,
      penaltyValue: noShowPenalty === "percent" || noShowPenalty === "fixed" ? num(get("noShowPenaltyValue")) : undefined,
    },
    overrideNote: get("cancellationNote").trim() || undefined,
  };
}

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
  const money = (v: FormDataEntryValue | null) => {
    const n = Math.round(Number(v) * 100) / 100;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  // Payment + cancellation + no-show policy (same builder the live preview uses).
  const policy = buildPolicy((n) => String(form.get(n) ?? ""));
  const tier0 = policy.cancellation.tiers[0];

  // Per-person pricing is opt-in: only stored when a default occupancy is set.
  const defaultOccupancy = posInt(form.get("defaultOccupancy"));
  const occupancyPricing: OccupancyPricing | undefined = defaultOccupancy
    ? {
        defaultOccupancy,
        extraAdultPrice: money(form.get("extraAdultPrice")),
        lessGuestDiscount: money(form.get("lessGuestDiscount")),
        child0to3: money(form.get("child0to3")),
        child4to12: money(form.get("child4to12")),
        child13plus: money(form.get("child13plus")),
      }
    : undefined;

  const rate: CatalogRate = {
    id: existing?.id ?? crypto.randomUUID(),
    title,
    mealPlan: String(form.get("mealPlan") ?? "").trim() || undefined,
    prices,
    occupancyPricing,
    policy,
    // Legacy mirrors (derived from the policy) so the cancellation engine works.
    refundable: policy.cancellation.refundable,
    cancelDeadlineValue: tier0?.deadlineValue,
    cancelDeadlineUnit: tier0?.deadlineUnit,
    cancellationNote: policy.overrideNote,
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
  // Effective policy (from rate.policy or legacy fields) for prefilling the form.
  const pol = ratePolicyOf(rate ?? {});
  const tier0 = pol.cancellation.tiers[0];
  // Track the selects that gate dependent fields, so we can disable the inputs
  // we don't need (deposit fields unless timing = Deposit; charge value only for
  // percentage / fixed penalties).
  const [payTiming, setPayTiming] = useState<string>(pol.payment.timing);
  const [latePenalty, setLatePenalty] = useState<string>(tier0?.penalty ?? "full_stay");
  const [noShowPenalty, setNoShowPenalty] = useState<string>(pol.noShow.penalty);
  const [refundable, setRefundable] = useState<boolean>(pol.cancellation.refundable);
  const needsValue = (p: string) => p === "percent" || p === "fixed";
  const disabledInput = `${FIELD_INPUT} disabled:cursor-not-allowed disabled:opacity-50`;

  // Live preview of the guest-facing policy text, recomputed from the form on any change.
  const formRef = useRef<HTMLFormElement>(null);
  const [preview, setPreview] = useState(() => describePolicy(pol));
  const refreshPreview = () => {
    const el = formRef.current;
    if (el) setPreview(describePolicy(buildPolicy((n) => String(new FormData(el).get(n) ?? ""))));
  };

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

      <Form ref={formRef} onChange={refreshPreview} method="post" className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6">
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

        <div className="border-t border-divider pt-5">
          <div className="mb-1 font-serif text-[17px] font-semibold">Payment</div>
          <p className="mb-3 text-[13px] text-muted">
            How and when the guest pays. This drives the checkout breakdown and policy text — it
            doesn&rsquo;t charge cards (no payment gateway is connected yet).
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-[13px] font-semibold text-secondary">
              Payment timing
              <select name="payTiming" value={payTiming} onChange={(e) => setPayTiming(e.target.value)} className={FIELD_INPUT}>
                {PAYMENT_TIMINGS.map((t) => (
                  <option key={t} value={t}>{PAYMENT_TIMING_LABEL[t]}</option>
                ))}
              </select>
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Card handling
              <select name="cardHandling" defaultValue={pol.payment.card} className={FIELD_INPUT}>
                {CARD_HANDLINGS.map((c) => (
                  <option key={c} value={c}>{CARD_HANDLING_LABEL[c]}</option>
                ))}
              </select>
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Deposit type <span className="font-normal text-faint">(when timing = Deposit)</span>
              <select name="depositType" defaultValue={pol.payment.deposit?.type ?? "percent"} disabled={payTiming !== "deposit"} className={disabledInput}>
                {DEPOSIT_TYPES.map((d) => (
                  <option key={d} value={d}>{DEPOSIT_TYPE_LABEL[d]}</option>
                ))}
              </select>
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Deposit value <span className="font-normal text-faint">(% , amount, or no. of nights)</span>
              <input name="depositValue" type="number" min={0} step="0.01" defaultValue={pol.payment.deposit?.value ?? ""} placeholder="e.g. 30" disabled={payTiming !== "deposit"} className={disabledInput} />
            </label>
          </div>
        </div>

        <div className="border-t border-divider pt-5">
          <div className="mb-1 font-serif text-[17px] font-semibold">Occupancy pricing</div>
          <p className="mb-3 text-[13px] text-muted">
            Optional. Set a default occupancy to price by party size — the nightly price above covers
            that many adults; extra adults add, fewer adults discount, and children are priced by age
            band (all per night). Leave the default occupancy blank to charge a flat price for any party.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="block text-[13px] font-semibold text-secondary">
              Default occupancy <span className="font-normal text-faint">(adults)</span>
              <input
                name="defaultOccupancy"
                type="number"
                min={1}
                defaultValue={rate?.occupancyPricing?.defaultOccupancy ?? ""}
                placeholder="2"
                className={FIELD_INPUT}
              />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Price per extra adult <span className="font-normal text-faint">(/night)</span>
              <input
                name="extraAdultPrice"
                type="number"
                min={0}
                step="0.01"
                defaultValue={rate?.occupancyPricing?.extraAdultPrice ?? ""}
                placeholder="30"
                className={FIELD_INPUT}
              />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Discount per fewer adult <span className="font-normal text-faint">(/night)</span>
              <input
                name="lessGuestDiscount"
                type="number"
                min={0}
                step="0.01"
                defaultValue={rate?.occupancyPricing?.lessGuestDiscount ?? ""}
                placeholder="20"
                className={FIELD_INPUT}
              />
            </label>
          </div>
          <div className="mt-3 text-[13px] font-semibold text-secondary">
            Child price per night <span className="font-normal text-faint">(per child, by age)</span>
          </div>
          <div className="mt-1.5 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="block text-[12.5px] font-semibold text-muted-2">
              Age 0–3
              <input name="child0to3" type="number" min={0} step="0.01" defaultValue={rate?.occupancyPricing?.child0to3 ?? ""} placeholder="0" className={FIELD_INPUT} />
            </label>
            <label className="block text-[12.5px] font-semibold text-muted-2">
              Age 4–12
              <input name="child4to12" type="number" min={0} step="0.01" defaultValue={rate?.occupancyPricing?.child4to12 ?? ""} placeholder="15" className={FIELD_INPUT} />
            </label>
            <label className="block text-[12.5px] font-semibold text-muted-2">
              Age 13+
              <input name="child13plus" type="number" min={0} step="0.01" defaultValue={rate?.occupancyPricing?.child13plus ?? ""} placeholder="25" className={FIELD_INPUT} />
            </label>
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
            <input
              type="checkbox"
              name="refundable"
              checked={refundable}
              onChange={(e) => setRefundable(e.target.checked)}
              className={checkbox}
            />
            Refundable (free cancellation)
          </label>
          {refundable ? (
            <>
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
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block text-[13px] font-semibold text-secondary">
                  Late-cancellation charge <span className="font-normal text-faint">(after the deadline)</span>
                  <select name="latePenalty" value={latePenalty} onChange={(e) => setLatePenalty(e.target.value)} className={FIELD_INPUT}>
                    {PENALTY_TYPES.map((p) => (
                      <option key={p} value={p}>{PENALTY_LABEL[p]}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-[13px] font-semibold text-secondary">
                  Charge value <span className="font-normal text-faint">(% or amount; for percentage / fixed)</span>
                  <input name="latePenaltyValue" type="number" min={0} step="0.01" defaultValue={tier0?.penaltyValue ?? ""} placeholder="e.g. 50" disabled={!needsValue(latePenalty)} className={disabledInput} />
                </label>
              </div>
            </>
          ) : (
            <p className="text-[13px] text-muted">All bookings are non-refundable — no free cancellation.</p>
          )}
        </div>

        <div className="border-t border-divider pt-5">
          <div className="mb-1 font-serif text-[17px] font-semibold">No-show</div>
          <p className="mb-3 text-[13px] text-muted">What&rsquo;s charged if the guest never arrives and doesn&rsquo;t cancel.</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-[13px] font-semibold text-secondary">
              No-show charge
              <select name="noShowPenalty" value={noShowPenalty} onChange={(e) => setNoShowPenalty(e.target.value)} className={FIELD_INPUT}>
                {PENALTY_TYPES.map((p) => (
                  <option key={p} value={p}>{PENALTY_LABEL[p]}</option>
                ))}
              </select>
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Charge value <span className="font-normal text-faint">(% or amount; for percentage / fixed)</span>
              <input name="noShowPenaltyValue" type="number" min={0} step="0.01" defaultValue={pol.noShow.penaltyValue ?? ""} placeholder="e.g. 100" disabled={!needsValue(noShowPenalty)} className={disabledInput} />
            </label>
          </div>
        </div>

        <label className="flex items-center gap-2.5 border-t border-divider pt-5 text-[14px] font-semibold">
          <input type="checkbox" name="active" defaultChecked={rate ? rate.active : true} className={checkbox} />
          Active (bookable by guests)
        </label>

        <div className="border-t border-divider pt-5">
          <div className="mb-2 font-serif text-[17px] font-semibold">What guests will see</div>
          <p className="mb-3 text-[13px] text-muted">
            Live preview of the policy text shown on the booking page (the guest sees it in their
            language, with the actual amounts).
          </p>
          <div className="flex flex-col gap-1.5 rounded-[12px] border border-line bg-surface-alt/50 p-4 text-[14px] text-secondary">
            <div>{preview.payment}</div>
            <div>{preview.cancellation}</div>
            {preview.noShow && <div>{preview.noShow}</div>}
          </div>
          <label className="mt-4 block text-[13px] font-semibold text-secondary">
            Override note <span className="font-normal text-faint">(optional — replaces the cancellation line above)</span>
            <input name="cancellationNote" defaultValue={pol.overrideNote} placeholder="Leave blank to show the policy generated from the fields above." className={FIELD_INPUT} />
          </label>
        </div>

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
