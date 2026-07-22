import { useRef, useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/rate";
import { useAdminT } from "~/lib/admin-i18n";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { isDeadlineUnit } from "~/lib/content";
import { deleteRate, getRate, getRooms, saveRate, type CatalogRate, type OccupancyPricing } from "~/lib/catalog.server";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";
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
    await queueGoogleAriPush(propertyId, ["property_data", "ari"]);
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
  const readOccupancy = (prefix: string): OccupancyPricing | undefined => {
    const defaultOccupancy = posInt(form.get(`${prefix}defaultOccupancy`));
    if (!defaultOccupancy) return undefined;
    return {
      defaultOccupancy,
      extraAdultPrice: money(form.get(`${prefix}extraAdultPrice`)),
      lessGuestDiscount: money(form.get(`${prefix}lessGuestDiscount`)),
      child0to3: money(form.get(`${prefix}child0to3`)),
      child4to12: money(form.get(`${prefix}child4to12`)),
      child13plus: money(form.get(`${prefix}child13plus`)),
    };
  };
  // Rate-wide default (also the fallback for rooms without a per-room override).
  const occupancyPricing = readOccupancy("");
  // Optional per-room overrides — only when the "per room" toggle is on. Each
  // room needs its own default occupancy to be included, mirroring the rate-wide
  // opt-in rule; rooms left blank fall back to the rate-wide pricing above.
  let occupancyPricingByRoom: Record<string, OccupancyPricing> | undefined;
  if (form.get("perRoomOccupancy") === "on") {
    const map: Record<string, OccupancyPricing> = {};
    for (const room of rooms) {
      const op = readOccupancy(`op:${room.id}:`);
      if (op) map[room.id] = op;
    }
    if (Object.keys(map).length > 0) occupancyPricingByRoom = map;
  }

  const rate: CatalogRate = {
    id: existing?.id ?? crypto.randomUUID(),
    title,
    mealPlan: String(form.get("mealPlan") ?? "").trim() || undefined,
    prices,
    occupancyPricing,
    occupancyPricingByRoom,
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
  await queueGoogleAriPush(propertyId, ["property_data", "ari"]);
  return isNew ? redirect(`/admin/rates/${rate.id}`) : { ok: true };
}

export function meta() {
  return [{ title: "Admin · Rate" }];
}

export default function AdminRate({ loaderData, actionData }: Route.ComponentProps) {
  const t = useAdminT();
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

  // Per-room occupancy pricing: a table of editable rows, one per room, gated by
  // a toggle. Off = the rate-wide fields apply everywhere (the common case). On =
  // each room can override; rows autofill from the rate-wide values so the owner
  // only tweaks the rooms that differ.
  const OP_FIELDS = ["defaultOccupancy", "extraAdultPrice", "lessGuestDiscount", "child0to3", "child4to12", "child13plus"] as const;
  type OpField = (typeof OP_FIELDS)[number];
  type OpRow = Record<OpField, string>;
  const emptyRow = (): OpRow => ({ defaultOccupancy: "", extraAdultPrice: "", lessGuestDiscount: "", child0to3: "", child4to12: "", child13plus: "" });
  const opToRow = (op?: OccupancyPricing): OpRow => {
    const row = emptyRow();
    if (op) for (const f of OP_FIELDS) if (op[f] != null) row[f] = String(op[f]);
    return row;
  };
  const [perRoomOcc, setPerRoomOcc] = useState<boolean>(
    !!rate?.occupancyPricingByRoom && Object.keys(rate.occupancyPricingByRoom).length > 0,
  );
  const [occRows, setOccRows] = useState<Record<string, OpRow>>(() => {
    const out: Record<string, OpRow> = {};
    for (const r of rooms) out[r.id] = opToRow(rate?.occupancyPricingByRoom?.[r.id] ?? rate?.occupancyPricing);
    return out;
  });
  const setOccCell = (roomId: string, field: OpField, value: string) =>
    setOccRows((prev) => ({ ...prev, [roomId]: { ...(prev[roomId] ?? emptyRow()), [field]: value } }));
  // Enabling: autofill any blank room row from the current rate-wide field values.
  const enablePerRoomOcc = () => {
    const el = formRef.current;
    const fd = el ? new FormData(el) : null;
    const wide = emptyRow();
    if (fd) for (const f of OP_FIELDS) wide[f] = String(fd.get(f) ?? "");
    setOccRows((prev) => {
      const out: Record<string, OpRow> = {};
      for (const r of rooms) {
        const cur = prev[r.id] ?? emptyRow();
        out[r.id] = OP_FIELDS.every((f) => !cur[f]) ? { ...wide } : cur;
      }
      return out;
    });
    setPerRoomOcc(true);
  };
  const OP_COL_LABEL: Record<OpField, string> = {
    defaultOccupancy: t("rtColDefaultOcc"),
    extraAdultPrice: t("rtColExtraAdult"),
    lessGuestDiscount: t("rtColFewerAdult"),
    child0to3: t("rtAge0to3"),
    child4to12: t("rtAge4to12"),
    child13plus: t("rtAge13plus"),
  };

  return (
    <div>
      <Link
        to="/admin/rates"
        className="mb-4 inline-block text-[13px] font-semibold text-muted hover:text-accent"
      >
        {t("rtBackAll")}
      </Link>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">{isNew ? t("rtNewTitle") : rate?.title}</h1>
        {actionData && "ok" in actionData && actionData.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            {t("saved")}
          </span>
        )}
      </div>

      <Form ref={formRef} onChange={refreshPreview} method="post" className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <label className="block text-[13px] font-semibold text-secondary">
            {t("rtNameLabel")}
            <input name="title" defaultValue={rate?.title} placeholder={t("rtNamePlaceholder")} className={FIELD_INPUT} />
          </label>
          <label className="block text-[13px] font-semibold text-secondary">
            {t("rtMealPlan")} <span className="font-normal text-faint">{t("rtOptional")}</span>
            <input name="mealPlan" defaultValue={rate?.mealPlan} placeholder={t("rtMealPlanPlaceholder")} className={FIELD_INPUT} />
          </label>
        </div>

        <div className="border-t border-divider pt-5">
          <div className="mb-1 font-serif text-[17px] font-semibold">{t("rtPricesTitle")}</div>
          <p className="mb-3 text-[13px] text-muted">
            {t("rtPricesIntro")}
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
          <div className="mb-1 font-serif text-[17px] font-semibold">{t("rtPaymentTitle")}</div>
          <p className="mb-3 text-[13px] text-muted">
            {t("rtPaymentIntro")}
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-[13px] font-semibold text-secondary">
              {t("rtPayTiming")}
              <select name="payTiming" value={payTiming} onChange={(e) => setPayTiming(e.target.value)} className={FIELD_INPUT}>
                {PAYMENT_TIMINGS.map((t) => (
                  <option key={t} value={t}>{PAYMENT_TIMING_LABEL[t]}</option>
                ))}
              </select>
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              {t("rtCardHandling")}
              <select name="cardHandling" defaultValue={pol.payment.card} className={FIELD_INPUT}>
                {CARD_HANDLINGS.map((c) => (
                  <option key={c} value={c}>{CARD_HANDLING_LABEL[c]}</option>
                ))}
              </select>
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              {t("rtDepositType")} <span className="font-normal text-faint">{t("rtDepositTypeHint")}</span>
              <select name="depositType" defaultValue={pol.payment.deposit?.type ?? "percent"} disabled={payTiming !== "deposit"} className={disabledInput}>
                {DEPOSIT_TYPES.map((d) => (
                  <option key={d} value={d}>{DEPOSIT_TYPE_LABEL[d]}</option>
                ))}
              </select>
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              {t("rtDepositValue")} <span className="font-normal text-faint">{t("rtDepositValueHint")}</span>
              <input name="depositValue" type="number" min={0} step="0.01" defaultValue={pol.payment.deposit?.value ?? ""} placeholder={t("rtEg", { v: 30 })} disabled={payTiming !== "deposit"} className={disabledInput} />
            </label>
          </div>
        </div>

        <div className="border-t border-divider pt-5">
          <div className="mb-1 font-serif text-[17px] font-semibold">{t("rtOccTitle")}</div>
          <p className="mb-3 text-[13px] text-muted">
            {t("rtOccIntro")}
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="block text-[13px] font-semibold text-secondary">
              {t("rtDefaultOcc")} <span className="font-normal text-faint">{t("rtDefaultOccHint")}</span>
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
              {t("rtExtraAdult")} <span className="font-normal text-faint">{t("rtPerNightHint")}</span>
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
              {t("rtFewerAdult")} <span className="font-normal text-faint">{t("rtPerNightHint")}</span>
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
            {t("rtChildTitle")} <span className="font-normal text-faint">{t("rtChildHint")}</span>
          </div>
          <div className="mt-1.5 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="block text-[12.5px] font-semibold text-muted-2">
              {t("rtAge0to3")}
              <input name="child0to3" type="number" min={0} step="0.01" defaultValue={rate?.occupancyPricing?.child0to3 ?? ""} placeholder="0" className={FIELD_INPUT} />
            </label>
            <label className="block text-[12.5px] font-semibold text-muted-2">
              {t("rtAge4to12")}
              <input name="child4to12" type="number" min={0} step="0.01" defaultValue={rate?.occupancyPricing?.child4to12 ?? ""} placeholder="15" className={FIELD_INPUT} />
            </label>
            <label className="block text-[12.5px] font-semibold text-muted-2">
              {t("rtAge13plus")}
              <input name="child13plus" type="number" min={0} step="0.01" defaultValue={rate?.occupancyPricing?.child13plus ?? ""} placeholder="25" className={FIELD_INPUT} />
            </label>
          </div>

          <label className="mt-5 flex items-center gap-2.5 text-[14px] font-semibold">
            <input
              type="checkbox"
              checked={perRoomOcc}
              onChange={(e) => (e.target.checked ? enablePerRoomOcc() : setPerRoomOcc(false))}
              className={checkbox}
            />
            {t("rtPerRoomToggle")}
            <span className="font-normal text-faint">{t("rtPerRoomToggleHint")}</span>
          </label>

          {perRoomOcc && (
            <div className="mt-3">
              {/* Marks per-room mode as on for the action; the row inputs below carry the values. */}
              <input type="hidden" name="perRoomOccupancy" value="on" />
              <div className="overflow-x-auto rounded-[12px] border border-line">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="bg-surface-alt/60 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                      <th className="px-3 py-2 text-left">{t("rtRoomCol")}</th>
                      {OP_FIELDS.map((f) => (
                        <th key={f} className="px-2 py-2 text-center font-semibold">{OP_COL_LABEL[f]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rooms.map((r, i) => (
                      <tr key={r.id} className={i > 0 ? "border-t border-divider" : ""}>
                        <td className="whitespace-nowrap px-3 py-2 font-semibold text-secondary">{r.title}</td>
                        {OP_FIELDS.map((f) => (
                          <td key={f} className="px-1.5 py-1.5">
                            <input
                              name={`op:${r.id}:${f}`}
                              type="number"
                              min={0}
                              step={f === "defaultOccupancy" ? 1 : 0.01}
                              value={occRows[r.id]?.[f] ?? ""}
                              onChange={(e) => setOccCell(r.id, f, e.target.value)}
                              className="w-[76px] rounded-[8px] border border-line-alt bg-surface-alt px-2 py-1.5 text-right text-[14px] text-ink outline-none focus:border-accent"
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[12px] text-faint">
                {t("rtPerRoomHint")}
              </p>
            </div>
          )}
        </div>

        <label className="block text-[13px] font-semibold text-secondary">
          {t("rtInclusions")} <span className="font-normal text-faint">{t("rtOnePerLine")}</span>
          <textarea
            name="inclusions"
            rows={3}
            defaultValue={rate?.inclusions.join("\n")}
            placeholder={t("rtInclusionsPlaceholder")}
            className={`${FIELD_INPUT} resize-y`}
          />
        </label>

        <div className="border-t border-divider pt-5">
          <div className="mb-3 font-serif text-[17px] font-semibold">{t("rtCancelTitle")}</div>
          <label className="mb-3 flex items-center gap-2.5 text-[14px] font-semibold">
            <input
              type="checkbox"
              name="refundable"
              checked={refundable}
              onChange={(e) => setRefundable(e.target.checked)}
              className={checkbox}
            />
            {t("rtRefundable")}
          </label>
          {refundable ? (
            <>
              <div className="text-[13px] font-semibold text-secondary">{t("rtFreeCancelUpTo")}</div>
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
                  <option value="hours">{t("rtHours")}</option>
                  <option value="days">{t("rtDays")}</option>
                </select>
                <span className="text-[13px] text-muted-2">{t("rtBeforeArrival")}</span>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block text-[13px] font-semibold text-secondary">
                  {t("rtLateCharge")} <span className="font-normal text-faint">{t("rtLateChargeHint")}</span>
                  <select name="latePenalty" value={latePenalty} onChange={(e) => setLatePenalty(e.target.value)} className={FIELD_INPUT}>
                    {PENALTY_TYPES.map((p) => (
                      <option key={p} value={p}>{PENALTY_LABEL[p]}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-[13px] font-semibold text-secondary">
                  {t("rtChargeValue")} <span className="font-normal text-faint">{t("rtChargeValueHint")}</span>
                  <input name="latePenaltyValue" type="number" min={0} step="0.01" defaultValue={tier0?.penaltyValue ?? ""} placeholder={t("rtEg", { v: 50 })} disabled={!needsValue(latePenalty)} className={disabledInput} />
                </label>
              </div>
            </>
          ) : (
            <p className="text-[13px] text-muted">{t("rtNonRefundableNote")}</p>
          )}
        </div>

        <div className="border-t border-divider pt-5">
          <div className="mb-1 font-serif text-[17px] font-semibold">{t("rtNoShowTitle")}</div>
          <p className="mb-3 text-[13px] text-muted">{t("rtNoShowIntro")}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-[13px] font-semibold text-secondary">
              {t("rtNoShowCharge")}
              <select name="noShowPenalty" value={noShowPenalty} onChange={(e) => setNoShowPenalty(e.target.value)} className={FIELD_INPUT}>
                {PENALTY_TYPES.map((p) => (
                  <option key={p} value={p}>{PENALTY_LABEL[p]}</option>
                ))}
              </select>
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              {t("rtChargeValue")} <span className="font-normal text-faint">{t("rtChargeValueHint")}</span>
              <input name="noShowPenaltyValue" type="number" min={0} step="0.01" defaultValue={pol.noShow.penaltyValue ?? ""} placeholder={t("rtEg", { v: 100 })} disabled={!needsValue(noShowPenalty)} className={disabledInput} />
            </label>
          </div>
        </div>

        <label className="flex items-center gap-2.5 border-t border-divider pt-5 text-[14px] font-semibold">
          <input type="checkbox" name="active" defaultChecked={rate ? rate.active : true} className={checkbox} />
          {t("rtActive")}
        </label>

        <div className="border-t border-divider pt-5">
          <div className="mb-2 font-serif text-[17px] font-semibold">{t("rtPreviewTitle")}</div>
          <p className="mb-3 text-[13px] text-muted">
            {t("rtPreviewIntro")}
          </p>
          <div className="flex flex-col gap-1.5 rounded-[12px] border border-line bg-surface-alt/50 p-4 text-[14px] text-secondary">
            <div>{preview.payment}</div>
            <div>{preview.cancellation}</div>
            {preview.noShow && <div>{preview.noShow}</div>}
          </div>
          <label className="mt-4 block text-[13px] font-semibold text-secondary">
            {t("rtOverrideNote")} <span className="font-normal text-faint">{t("rtOverrideNoteHint")}</span>
            <input name="cancellationNote" defaultValue={pol.overrideNote} placeholder={t("rtOverrideNotePlaceholder")} className={FIELD_INPUT} />
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
            {saving ? t("saving") : isNew ? t("rtCreate") : t("rtSave")}
          </button>
        </div>
      </Form>

      {!isNew && (
        <Form
          method="post"
          className="mt-4"
          onSubmit={(e) => {
            if (!confirm(t("rtDeleteConfirm"))) e.preventDefault();
          }}
        >
          <button type="submit" name="intent" value="delete" className="text-[13px] font-semibold text-[#c0392b] hover:underline">
            {t("rtDelete")}
          </button>
        </Form>
      )}
    </div>
  );
}
