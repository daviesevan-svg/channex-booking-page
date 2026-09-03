import { useRef, useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/rate";
import { adminMeta } from "~/lib/admin-meta";
import { useAdminT } from "~/lib/admin-i18n";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { DEFAULT_LANG, isDeadlineUnit, langParam, pickLang } from "~/lib/content";
import { deleteRate, getPricingMode, getRate, getRates, getRooms, pricingModeOf, saveRate, type CatalogRate, type OccupancyPricing, type RateTranslation } from "~/lib/catalog.server";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";
import {
  CARD_HANDLINGS,
  DEPOSIT_TYPES,
  PAYMENT_TIMINGS,
  PENALTY_TYPES,
  describePolicy,
  ratePolicyOf,
  type CancelTier,
  type RatePolicy,
} from "~/lib/rate-policy";
import { FIELD_INPUT, TranslationNote } from "~/components/admin-form";
import { AdminPageHeader } from "~/components/admin-page-header";
import { activeGateway } from "~/lib/payments.server";
import { DEFAULT_CANCEL_ANCHOR } from "~/lib/dates";
import { getSettings } from "~/lib/overrides.server";

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
  const nonNegInt = (v: string) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const pick = <T extends string>(v: string, allowed: readonly T[], fb: T): T =>
    (allowed as readonly string[]).includes(v) ? (v as T) : fb;

  const refundable = get("refundable") !== "";
  // 0 is a real deadline — with the property's 18:00 anchor it means "free until
  // 6pm on the day of arrival", the flexible-city-hotel policy. An EMPTY box still
  // means no deadline, so the two stay distinguishable.
  const cdvRaw = get("cancelDeadlineValue").trim();
  const cdv = cdvRaw === "" ? undefined : nonNegInt(cdvRaw);
  const rawUnit = get("cancelDeadlineUnit");
  const cdu = isDeadlineUnit(rawUnit) ? rawUnit : "hours";
  const latePenalty = pick(get("latePenalty"), PENALTY_TYPES, "full_stay");
  const tiers: CancelTier[] =
    refundable && cdv != null
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
  // Whether a card can be taken at all. Penalties on a rate are only
  // enforceable if there's something on file to charge.
  const settings = await getSettings(propertyId);
  const canTakeCard = Boolean(await activeGateway(propertyId, settings));
  // A new rate is always created in the default language — there is no default
  // text to translate yet — so the editor ignores the language tab until saved.
  const lang = isNew ? DEFAULT_LANG : langParam(request);
  // RAW per-language text, empty until translated (see TranslationNote) — the
  // default-language content must never appear editable on a translation tab,
  // or saving it writes the default text into the translation (or worse).
  const tr: RateTranslation = lang === DEFAULT_LANG ? {} : (rate?.translations?.[lang] ?? {});
  return {
    isNew,
    rate,
    lang,
    tr,
    canTakeCard,
    // Property-wide (set on General): every rate prices per room or per person.
    perPerson: pricingModeOf(settings, await getRates(propertyId)) === "per_person",
    // The deadline counts back from this wall-clock time on the arrival date, so
    // the field can say what a given number actually resolves to.
    cancelAnchor: settings.cancelAnchorTime || DEFAULT_CANCEL_ANCHOR,
    rooms: rooms.map((r) => ({ id: r.id, title: r.title })),
  };
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

  // The language tab the form was rendered under. New rates always save the
  // default: there is no default text to translate yet.
  const lang = isNew ? DEFAULT_LANG : pickLang(String(form.get("lang") ?? ""));
  const onDefault = lang === DEFAULT_LANG;

  const title = String(form.get("title") ?? "").trim();
  // A translation tab may leave any text blank (= fall back to the default),
  // but the default name is what everything falls back TO, so it must exist.
  if (onDefault && !title) return { error: "Enter a rate name." };

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
  // On a translation tab the override-note field holds THAT language's text, so
  // it goes into translations[lang] below — the default-language note isn't in
  // the form and must be carried over onto the policy untouched.
  const noteTr = policy.overrideNote;
  if (!onDefault) policy.overrideNote = existing ? ratePolicyOf(existing).overrideNote : undefined;
  const tier0 = policy.cancellation.tiers[0];

  // Per-person pricing is property-wide (settings.pricingMode, set on General):
  // in that mode the price is per adult (Channex pushes one price per occupancy;
  // manual prices multiply by the party's adults).
  const perPerson = (await getPricingMode(propertyId)) === "per_person";

  // Children priced as adults is a rate-wide switch: it rides on every
  // occupancyPricing object (including per-room overrides) so the pricing
  // math sees it wherever the effective `op` comes from.
  const childrenAsAdults = form.get("childrenAsAdults") != null || undefined;
  // Occupancy pricing is opt-in: only stored when a default occupancy is set.
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
      childrenAsAdults,
    };
  };
  // Rate-wide default (also the fallback for rooms without a per-room override).
  let occupancyPricing = readOccupancy("");
  // A per-person rate needs no default occupancy — adults price themselves —
  // but the child age bands (and the children-as-adults switch) still ride on
  // occupancyPricing, so store them with a nominal default occupancy when set.
  // (The adult fields are ignored by per-person pricing either way.)
  if (perPerson && !occupancyPricing) {
    const kids = {
      child0to3: money(form.get("child0to3")),
      child4to12: money(form.get("child4to12")),
      child13plus: money(form.get("child13plus")),
    };
    if (kids.child0to3 || kids.child4to12 || kids.child13plus || childrenAsAdults) {
      occupancyPricing = { defaultOccupancy: 1, ...kids, childrenAsAdults };
    }
  }
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

  const mealPlan = String(form.get("mealPlan") ?? "").trim();
  const inclusions = String(form.get("inclusions") ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  // On a translation tab the four text fields hold THAT language's raw text
  // (empty = untranslated), so they update only translations[lang] — the
  // default text isn't even in the form and must be carried over untouched.
  // Everything else (prices, policy, occupancy) is language-independent and
  // saves the same whichever tab is open.
  let translations = existing?.translations;
  if (!onDefault) {
    const entry: RateTranslation = {
      ...(title ? { title } : {}),
      ...(mealPlan ? { mealPlan } : {}),
      ...(inclusions.length ? { inclusions } : {}),
      ...(noteTr ? { cancellationNote: noteTr } : {}),
    };
    const next = { ...translations };
    if (Object.keys(entry).length) next[lang] = entry;
    else delete next[lang];
    translations = Object.keys(next).length ? next : undefined;
  }

  const rate: CatalogRate = {
    id: existing?.id ?? crypto.randomUUID(),
    title: onDefault ? title : (existing?.title ?? title),
    mealPlan: onDefault ? mealPlan || undefined : existing?.mealPlan,
    prices,
    // Legacy flag, no longer edited here — preserved so a property that never
    // saved General still derives its mode from it (see pricingModeOf).
    perPerson: existing?.perPerson,
    // Not edited here either, but ARI/mapping/booking pushes key by these
    // per-room Channex ids (see rateChannexId) — dropping them on save would
    // orphan an imported rate's ARI rows.
    channexRateIds: existing?.channexRateIds,
    occupancyPricing,
    occupancyPricingByRoom,
    policy,
    // Legacy mirrors (derived from the policy) so the cancellation engine works.
    refundable: policy.cancellation.refundable,
    cancelDeadlineValue: tier0?.deadlineValue,
    cancelDeadlineUnit: tier0?.deadlineUnit,
    cancellationNote: policy.overrideNote,
    inclusions: onDefault ? inclusions : (existing?.inclusions ?? []),
    active: form.get("active") != null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    translations,
  };
  await saveRate(propertyId, rate);
  await queueGoogleAriPush(propertyId, ["property_data", "ari"]);
  return isNew ? redirect(`/admin/rates/${rate.id}`) : { ok: true };
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "mtRate" });
}

export default function AdminRate({ loaderData, actionData }: Route.ComponentProps) {
  const t = useAdminT();
  const { isNew, rate, lang, tr, rooms, canTakeCard, cancelAnchor, perPerson } = loaderData;
  const onDefault = lang === DEFAULT_LANG;
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
  const [preview, setPreview] = useState(() => describePolicy(pol, cancelAnchor));
  const refreshPreview = () => {
    const el = formRef.current;
    if (el) setPreview(describePolicy(buildPolicy((n) => String(new FormData(el).get(n) ?? "")), cancelAnchor));
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
  // Children priced as adults: the age-band fields become dead config, so hide
  // them (kept mounted so their values survive toggling the switch off again).
  const [childAsAdults, setChildAsAdults] = useState<boolean>(!!rate?.occupancyPricing?.childrenAsAdults);
  const childField = (f: OpField) => f === "child0to3" || f === "child4to12" || f === "child13plus";
  // Per-person pricing (property-wide, from General): prices are per adult, so
  // the adult occupancy fields (default occupancy / extra adult / fewer adults)
  // don't apply and are hidden.
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
      <AdminPageHeader title={isNew ? t("rtNewTitle") : rate?.title} saved={Boolean(actionData && "ok" in actionData && actionData.ok)} />

      <TranslationNote lang={lang} />

      <Form ref={formRef} onChange={refreshPreview} method="post" key={lang} className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6">
        <input type="hidden" name="lang" value={lang} />
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <label className="block text-[13px] font-semibold text-secondary">
            {t("rtNameLabel")}
            <input name="title" defaultValue={onDefault ? rate?.title : tr.title} placeholder={onDefault ? t("rtNamePlaceholder") : undefined} className={FIELD_INPUT} />
          </label>
          <label className="block text-[13px] font-semibold text-secondary">
            {t("rtMealPlan")} <span className="font-normal text-faint">{t("rtOptional")}</span>
            <input name="mealPlan" defaultValue={onDefault ? rate?.mealPlan : tr.mealPlan} placeholder={onDefault ? t("rtMealPlanPlaceholder") : undefined} className={FIELD_INPUT} />
          </label>
        </div>

        <div className="border-t border-divider pt-5">
          <div className="mb-1 font-serif text-[17px] font-semibold">{t("rtPricesTitle")}</div>
          <p className="mb-3 text-[13px] text-muted">
            {perPerson ? t("rtPricesIntroPerPerson") : t("rtPricesIntro")}{" "}
            {t("rtPricingModeNote")}{" "}
            <Link to="/admin/general" className="font-semibold text-accent hover:underline">
              {t("navGeneral")}
            </Link>
            .
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
            {t(canTakeCard ? "rtPaymentIntroCharge" : "rtPaymentIntroNoGateway")}
          </p>

          {/* A penalty you can't charge is a term you can't enforce. Warn where
              the hotelier can act on it rather than letting the guest agree to
              something that quietly means nothing. */}
          {!canTakeCard && (!refundable || noShowPenalty !== "none") && (
            <p className="mb-4 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] text-amber-800">
              <span className="font-semibold">{t("rtNoCardWarnTitle")}</span> {t("rtNoCardWarnBody")}{" "}
              <Link to="/admin/payments" className="font-semibold underline">{t("rtNoCardWarnLink")}</Link>
            </p>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-[13px] font-semibold text-secondary">
              {t("rtPayTiming")}
              <select name="payTiming" value={payTiming} onChange={(e) => setPayTiming(e.target.value)} className={FIELD_INPUT}>
                {PAYMENT_TIMINGS.map((v) => (
                  <option key={v} value={v}>{t(`rtOptTiming_${v}`)}</option>
                ))}
              </select>
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              {t("rtCardHandling")}
              <select name="cardHandling" defaultValue={pol.payment.card} className={FIELD_INPUT}>
                {CARD_HANDLINGS.map((c) => (
                  <option key={c} value={c}>{t(`rtOptCard_${c}`)}</option>
                ))}
              </select>
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              {t("rtDepositType")} <span className="font-normal text-faint">{t("rtDepositTypeHint")}</span>
              <select name="depositType" defaultValue={pol.payment.deposit?.type ?? "percent"} disabled={payTiming !== "deposit"} className={disabledInput}>
                {DEPOSIT_TYPES.map((d) => (
                  <option key={d} value={d}>{t(`rtOptDeposit_${d}`)}</option>
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
            {perPerson ? t("rtOccIntroPerPerson") : t("rtOccIntro")}
          </p>
          {!perPerson && (
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
          )}
          <label className="mt-4 flex items-center gap-2.5 text-[14px] font-semibold">
            <input
              type="checkbox"
              name="childrenAsAdults"
              checked={childAsAdults}
              onChange={(e) => setChildAsAdults(e.target.checked)}
              className={checkbox}
            />
            {t("rtChildAsAdults")}
            <span className="font-normal text-faint">{t("rtChildAsAdultsHint")}</span>
          </label>
          {/* Hidden (not unmounted) when children price as adults, so the band
              values keep submitting and survive toggling the switch back off. */}
          <div className={childAsAdults ? "hidden" : undefined}>
            <div className="mt-3 text-[13px] font-semibold text-secondary">
              {t("rtChildTitle")} <span className="font-normal text-faint">{t("rtChildHint")}</span>
            </div>
            <div className="mt-1.5 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <label className="block text-[12px] font-semibold text-muted-2">
                {t("rtAge0to3")}
                <input name="child0to3" type="number" min={0} step="0.01" defaultValue={rate?.occupancyPricing?.child0to3 ?? ""} placeholder="0" className={FIELD_INPUT} />
              </label>
              <label className="block text-[12px] font-semibold text-muted-2">
                {t("rtAge4to12")}
                <input name="child4to12" type="number" min={0} step="0.01" defaultValue={rate?.occupancyPricing?.child4to12 ?? ""} placeholder="15" className={FIELD_INPUT} />
              </label>
              <label className="block text-[12px] font-semibold text-muted-2">
                {t("rtAge13plus")}
                <input name="child13plus" type="number" min={0} step="0.01" defaultValue={rate?.occupancyPricing?.child13plus ?? ""} placeholder="25" className={FIELD_INPUT} />
              </label>
            </div>
          </div>

          {!perPerson && (
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
          )}

          {!perPerson && perRoomOcc && (
            <div className="mt-3">
              {/* Marks per-room mode as on for the action; the row inputs below carry the values. */}
              <input type="hidden" name="perRoomOccupancy" value="on" />
              <div className="overflow-x-auto rounded-[12px] border border-line">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="bg-surface-alt/60 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                      <th className="px-3 py-2 text-left">{t("rtRoomCol")}</th>
                      {OP_FIELDS.map((f) => (
                        <th key={f} className={`px-2 py-2 text-center font-semibold${childAsAdults && childField(f) ? " hidden" : ""}`}>{OP_COL_LABEL[f]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rooms.map((r, i) => (
                      <tr key={r.id} className={i > 0 ? "border-t border-divider" : ""}>
                        <td className="whitespace-nowrap px-3 py-2 font-semibold text-secondary">{r.title}</td>
                        {OP_FIELDS.map((f) => (
                          <td key={f} className={`px-1.5 py-1.5${childAsAdults && childField(f) ? " hidden" : ""}`}>
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
            defaultValue={onDefault ? rate?.inclusions.join("\n") : tr.inclusions?.join("\n")}
            placeholder={onDefault ? t("rtInclusionsPlaceholder") : undefined}
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
              {/* Without this the field is genuinely ambiguous: "24 hours before
                  arrival" could mean midnight, and "0" looks like it means nothing
                  at all rather than the most useful setting on the page. */}
              <p className="mt-1.5 text-[12px] text-faint">
                {t("rtCancelAnchorHint", { time: cancelAnchor })}
              </p>
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block text-[13px] font-semibold text-secondary">
                  {t("rtLateCharge")} <span className="font-normal text-faint">{t("rtLateChargeHint")}</span>
                  <select name="latePenalty" value={latePenalty} onChange={(e) => setLatePenalty(e.target.value)} className={FIELD_INPUT}>
                    {PENALTY_TYPES.map((p) => (
                      <option key={p} value={p}>{t(`rtOptPenalty_${p}`)}</option>
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
                  <option key={p} value={p}>{t(`rtOptPenalty_${p}`)}</option>
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
            {preview.payment && <div>{preview.payment}</div>}
            <div>{preview.cancellation}</div>
            {preview.noShow && <div>{preview.noShow}</div>}
          </div>
          <label className="mt-4 block text-[13px] font-semibold text-secondary">
            {t("rtOverrideNote")} <span className="font-normal text-faint">{t("rtOverrideNoteHint")}</span>
            <input name="cancellationNote" defaultValue={onDefault ? pol.overrideNote : tr.cancellationNote} placeholder={onDefault ? t("rtOverrideNotePlaceholder") : undefined} className={FIELD_INPUT} />
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
