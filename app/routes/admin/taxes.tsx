import { useState } from "react";
import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/taxes";
import { FIELD_INPUT } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getSettings, saveTaxSettings } from "~/lib/overrides.server";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";
import { formatMoney } from "~/lib/money";
import {
  computePricing,
  type CityTaxBasis,
  type CityTaxConfig,
  type CityTaxSeason,
  type FeeRule,
  type TaxRule,
} from "~/lib/pricing";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Annual month-day picker ("MM-DD") for the seasonal city-tax ranges. */
function MonthDay({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [mm = "01", dd = "01"] = value.split("-");
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <span className="inline-flex items-center gap-1.5">
      <select
        value={dd}
        onChange={(e) => onChange(`${mm}-${e.target.value}`)}
        className="rounded-[8px] border border-line-alt bg-surface px-2 py-1.5 text-[13px] outline-none focus:border-accent"
      >
        {Array.from({ length: 31 }, (_, i) => (
          <option key={i} value={pad(i + 1)}>
            {i + 1}
          </option>
        ))}
      </select>
      <select
        value={mm}
        onChange={(e) => onChange(`${e.target.value}-${dd}`)}
        className="rounded-[8px] border border-line-alt bg-surface px-2 py-1.5 text-[13px] outline-none focus:border-accent"
      >
        {MONTHS.map((m, i) => (
          <option key={m} value={pad(i + 1)}>
            {m}
          </option>
        ))}
      </select>
    </span>
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const settings = await getSettings(propertyId);
  return {
    configured: true as const,
    currency: settings.currency || "GBP",
    inclusive: settings.taxesInclusive === true,
    taxes: settings.taxes ?? [],
    fees: settings.fees ?? [],
    cityTax: settings.cityTax ?? null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };
  await saveTaxSettings(propertyId, await request.formData());
  await queueGoogleAriPush(propertyId, ["taxes"]);
  return { ok: true };
}

export function meta() {
  return [{ title: "Admin · Taxes & Fees" }];
}

const rid = () => Math.random().toString(36).slice(2, 10);
const defaultCityTax = (): CityTaxConfig => ({
  enabled: true,
  name: "City tax",
  amount: 2,
  basis: "person_night",
  taxable: false,
  childrenExempt: true,
  maxNights: 0,
});

const BASIS_LABELS: Record<CityTaxBasis, string> = {
  person_night: "per person, per night",
  room_night: "per room, per night",
  room_stay: "per room, per stay",
};

const sectionCls = "rounded-[14px] border border-line bg-surface p-6";
const checkbox = "h-4 w-4 rounded border-line-alt text-accent focus:ring-accent";
const smallInput =
  "rounded-[10px] border border-line-alt bg-surface-alt px-3 py-2 text-[14px] text-ink outline-none focus:border-accent";

export default function AdminTaxes({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  const [inclusive, setInclusive] = useState(loaderData.configured ? loaderData.inclusive : false);
  const [taxes, setTaxes] = useState<TaxRule[]>(loaderData.configured ? loaderData.taxes : []);
  const [fees, setFees] = useState<FeeRule[]>(loaderData.configured ? loaderData.fees : []);
  const [cityTax, setCityTax] = useState<CityTaxConfig | null>(
    loaderData.configured ? loaderData.cityTax : null,
  );

  if (!loaderData.configured) {
    return (
      <div className={sectionCls}>
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Taxes &amp; Fees</h1>
        <p className="text-[15px] text-secondary">
          Set <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code> to configure
          taxes.
        </p>
      </div>
    );
  }

  const { currency } = loaderData;
  const money = (n: number) => formatMoney(n, currency);

  const setTax = (i: number, patch: Partial<TaxRule>) =>
    setTaxes((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const setFee = (i: number, patch: Partial<FeeRule>) =>
    setFees((prev) => prev.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const setCity = (patch: Partial<CityTaxConfig>) =>
    setCityTax((prev) => (prev ? { ...prev, ...patch } : prev));

  // Live worked example so the setup isn't a black box.
  const preview = computePricing(
    // Priced as if checking in today, so a seasonal city tax previews at the
    // currently applicable season's rate.
    { base: 200, nights: 2, adults: 2, children: 0, rooms: 1, checkin: new Date().toISOString().slice(0, 10) },
    { inclusive, taxes, fees, cityTax: cityTax ?? undefined },
  );

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">Taxes &amp; Fees</h1>
        {actionData?.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            ✓ Saved
          </span>
        )}
      </div>

      <Form method="post" className="flex flex-col gap-6">
        {/* serialized state */}
        <input type="hidden" name="taxesJson" value={JSON.stringify(taxes)} />
        <input type="hidden" name="feesJson" value={JSON.stringify(fees)} />
        <input type="hidden" name="cityTaxJson" value={JSON.stringify(cityTax ? [cityTax] : [])} />

        {/* 1. Taxes */}
        <section className={sectionCls}>
          <div className="mb-1 font-serif text-[18px] font-semibold">Tax</div>
          <p className="mb-4 text-[13.5px] text-muted">
            Percentage taxes like VAT. The toggle below decides whether your inventory prices already
            include them or they&rsquo;re added on top.
          </p>

          <label className="mb-4 flex items-center gap-2.5 text-[14px] font-semibold">
            <input
              type="checkbox"
              name="taxesInclusive"
              checked={inclusive}
              onChange={(e) => setInclusive(e.target.checked)}
              className={checkbox}
            />
            Inventory prices already include tax
            <span className="font-normal text-faint">
              {inclusive ? "(carved out of the price)" : "(added on top at checkout)"}
            </span>
          </label>

          <div className="flex flex-col gap-2.5">
            {taxes.map((t, i) => (
              <div key={t.id} className="flex items-center gap-2.5">
                <input
                  value={t.name}
                  onChange={(e) => setTax(i, { name: e.target.value })}
                  placeholder="VAT"
                  className={`${smallInput} flex-1`}
                />
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    value={t.rate}
                    onChange={(e) => setTax(i, { rate: Number(e.target.value) })}
                    className={`${smallInput} w-24 text-right`}
                  />
                  <span className="text-[14px] text-muted-2">%</span>
                </div>
                <button
                  type="button"
                  onClick={() => setTaxes((prev) => prev.filter((_, j) => j !== i))}
                  className="text-[13px] font-semibold text-[#c0392b] hover:underline"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setTaxes((prev) => [...prev, { id: rid(), name: "VAT", rate: 20 }])}
            className="mt-3 text-[13px] font-semibold text-accent hover:underline"
          >
            + Add tax
          </button>
        </section>

        {/* 2. City tax */}
        <section className={sectionCls}>
          <div className="mb-1 font-serif text-[18px] font-semibold">City tax</div>
          <p className="mb-4 text-[13.5px] text-muted">
            A fixed local tax, charged per person/room and night. Always added on top.
          </p>

          {!cityTax ? (
            <button
              type="button"
              onClick={() => setCityTax(defaultCityTax())}
              className="text-[13px] font-semibold text-accent hover:underline"
            >
              + Add city tax
            </button>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="block text-[13px] font-semibold text-secondary">
                  Name
                  <input
                    value={cityTax.name}
                    onChange={(e) => setCity({ name: e.target.value })}
                    placeholder="City tax"
                    className={FIELD_INPUT}
                  />
                </label>
                <label className="block text-[13px] font-semibold text-secondary">
                  Amount ({currency})
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={cityTax.amount}
                    onChange={(e) => setCity({ amount: Number(e.target.value) })}
                    className={FIELD_INPUT}
                  />
                </label>
                <label className="block text-[13px] font-semibold text-secondary">
                  Charged
                  <select
                    value={cityTax.basis}
                    onChange={(e) => setCity({ basis: e.target.value as CityTaxBasis })}
                    className={FIELD_INPUT}
                  >
                    {(Object.keys(BASIS_LABELS) as CityTaxBasis[]).map((b) => (
                      <option key={b} value={b}>
                        {BASIS_LABELS[b]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
                <label className="flex items-center gap-2 text-[14px] font-semibold">
                  <input
                    type="checkbox"
                    checked={cityTax.taxable}
                    onChange={(e) => setCity({ taxable: e.target.checked })}
                    className={checkbox}
                  />
                  VAT applies to city tax
                </label>
                <label className="flex items-center gap-2 text-[14px] font-semibold">
                  <input
                    type="checkbox"
                    checked={cityTax.childrenExempt}
                    onChange={(e) => setCity({ childrenExempt: e.target.checked })}
                    className={checkbox}
                  />
                  Children exempt
                </label>
                <label className="flex items-center gap-2 text-[14px] font-semibold">
                  <input
                    type="checkbox"
                    checked={!!cityTax.seasons}
                    onChange={(e) =>
                      setCity({
                        seasons: e.target.checked
                          ? [
                              { from: "04-01", to: "10-31", amount: cityTax.amount },
                              { from: "11-01", to: "03-31", amount: cityTax.amount },
                            ]
                          : undefined,
                      })
                    }
                    className={checkbox}
                  />
                  Advanced (seasonal rates)
                </label>
                <button
                  type="button"
                  onClick={() => setCityTax(null)}
                  className="text-[13px] font-semibold text-[#c0392b] hover:underline"
                >
                  Remove
                </button>
              </div>

              {/* Seasonal rates: each night is charged at the rate of the season
                  its date falls in — a cross-season stay mixes rates per night
                  (Greek overnight-fee model). Ranges recur every year and may
                  wrap the year end (e.g. 1 Nov → 31 Mar). */}
              {cityTax.seasons && (
                <div className="flex flex-col gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3.5">
                  {cityTax.seasons.map((s, i) => {
                    const setSeason = (patch: Partial<CityTaxSeason>) =>
                      setCity({ seasons: cityTax.seasons!.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                    return (
                      <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
                        <span className="w-16 font-semibold text-secondary">Season {i + 1}</span>
                        <MonthDay value={s.from} onChange={(from) => setSeason({ from })} />
                        <span className="text-muted-2">→</span>
                        <MonthDay value={s.to} onChange={(to) => setSeason({ to })} />
                        <label className="flex items-center gap-1.5 font-semibold text-secondary">
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={s.amount}
                            onChange={(e) => setSeason({ amount: Number(e.target.value) })}
                            className={`${smallInput} w-24`}
                          />
                          {currency}
                        </label>
                        {cityTax.seasons!.length > 2 && (
                          <button
                            type="button"
                            onClick={() => setCity({ seasons: cityTax.seasons!.filter((_, j) => j !== i) })}
                            className="text-[12.5px] font-semibold text-[#c0392b] hover:underline"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {cityTax.seasons.length < 3 && (
                    <button
                      type="button"
                      onClick={() =>
                        setCity({ seasons: [...cityTax.seasons!, { from: "01-01", to: "03-31", amount: cityTax.amount }] })
                      }
                      className="self-start text-[13px] font-semibold text-accent hover:underline"
                    >
                      + Add a third season
                    </button>
                  )}
                  <p className="text-[12px] text-muted">
                    Dates recur every year (a range may wrap the year end). Each night is charged at
                    its own date's rate — a stay spanning two seasons mixes them. Nights outside every
                    season use the base amount above.
                  </p>
                  <label className="flex items-center gap-2 text-[13px] font-semibold text-secondary">
                    Max nights charged
                    <input
                      type="number"
                      min={0}
                      value={cityTax.maxNights}
                      onChange={(e) => setCity({ maxNights: Number(e.target.value) })}
                      className={`${smallInput} w-20`}
                    />
                    <span className="font-normal text-faint">(0 = no cap)</span>
                  </label>
                </div>
              )}
            </div>
          )}
        </section>

        {/* 3. Fees */}
        <section className={sectionCls}>
          <div className="mb-1 font-serif text-[18px] font-semibold">Fees</div>
          <p className="mb-4 text-[13.5px] text-muted">
            Service charges or other extras, as a percentage of the room or a fixed amount. Always
            added on top.
          </p>

          <div className="flex flex-col gap-2.5">
            {fees.map((f, i) => (
              <div key={f.id} className="flex flex-wrap items-center gap-2.5">
                <input
                  value={f.name}
                  onChange={(e) => setFee(i, { name: e.target.value })}
                  placeholder="Service charge"
                  className={`${smallInput} min-w-[160px] flex-1`}
                />
                <select
                  value={f.kind}
                  onChange={(e) => setFee(i, { kind: e.target.value as FeeRule["kind"] })}
                  className={smallInput}
                >
                  <option value="percent">% of room</option>
                  <option value="fixed">Fixed ({currency})</option>
                </select>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={f.amount}
                  onChange={(e) => setFee(i, { amount: Number(e.target.value) })}
                  className={`${smallInput} w-24 text-right`}
                />
                <label className="flex items-center gap-2 text-[13px] font-semibold">
                  <input
                    type="checkbox"
                    checked={f.taxable}
                    onChange={(e) => setFee(i, { taxable: e.target.checked })}
                    className={checkbox}
                  />
                  VAT applies
                </label>
                <button
                  type="button"
                  onClick={() => setFees((prev) => prev.filter((_, j) => j !== i))}
                  className="text-[13px] font-semibold text-[#c0392b] hover:underline"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() =>
              setFees((prev) => [
                ...prev,
                { id: rid(), name: "Service charge", kind: "percent", amount: 10, taxable: true },
              ])
            }
            className="mt-3 text-[13px] font-semibold text-accent hover:underline"
          >
            + Add fee
          </button>
        </section>

        {/* Live preview */}
        <section className={`${sectionCls} bg-surface-alt`}>
          <div className="mb-1 font-serif text-[16px] font-semibold">Example</div>
          <p className="mb-3 text-[12.5px] text-muted">
            A 2-night stay for 2 adults at a {money(200)} room price.
          </p>
          <div className="flex flex-col gap-1.5 text-[14px]">
            <div className="flex justify-between">
              <span className="text-secondary">Room</span>
              <span className="font-semibold">{money(preview.base)}</span>
            </div>
            {preview.charges.map((c, i) => (
              <div key={i} className="flex justify-between">
                <span className="text-secondary">{c.label}</span>
                <span className="font-semibold">{money(c.amount)}</span>
              </div>
            ))}
            {preview.taxLines.map((c, i) => (
              <div key={i} className="flex justify-between">
                <span className="text-secondary">{c.label}</span>
                <span className="font-semibold">{money(c.amount)}</span>
              </div>
            ))}
            <div className="mt-1.5 flex justify-between border-t border-divider pt-2 text-[15px]">
              <span className="font-semibold">Total</span>
              <span className="font-serif text-[18px] font-semibold">{money(preview.total)}</span>
            </div>
            {preview.taxIncluded > 0 && (
              <div className="text-right text-[12px] text-muted-2">
                Includes {money(preview.taxIncluded)} VAT
              </div>
            )}
          </div>
        </section>

        {actionData?.error && <p className="text-[13px] text-red-600">{actionData.error}</p>}
        <div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </Form>
    </div>
  );
}
