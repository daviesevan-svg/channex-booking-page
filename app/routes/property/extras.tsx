import { differenceInCalendarDays, parseISO } from "date-fns";
import { useState } from "react";
import { Link, redirect, useNavigate, useSearchParams } from "react-router";

import type { Route } from "./+types/extras";
import { useProperty } from "~/lib/booking-context";
import { cartCovers, cartCoverage, parseCart, resolveCart, withinAvailability } from "~/lib/cart";
import { getCatalogRooms } from "~/lib/catalog.server";
import { getActiveExtras } from "~/lib/extras.server";
import {
  UNIT_LABEL,
  fromPrice,
  isConfigurable,
  parseExtras,
  resolveExtras,
  serializeExtras,
  type Extra,
  type ExtraSelection,
} from "~/lib/extras";
import { formatMoney } from "~/lib/money";
import { partySize, readOccupancy } from "~/lib/occupancy";
import { useT } from "~/lib/i18n";

export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const checkin = url.searchParams.get("checkin");
  const checkout = url.searchParams.get("checkout");
  const currency = url.searchParams.get("currency") || "GBP";
  const occ = readOccupancy(url.searchParams);
  if (!checkin || !checkout) throw redirect(`/${params.channelId}`);

  const rooms = await getCatalogRooms(
    params.channelId,
    { checkinDate: checkin, checkoutDate: checkout, currency, adults: occ.adults },
    { gate: true },
  );
  const lines = resolveCart(parseCart(url.searchParams), rooms);
  // Must have a valid room selection to enhance — otherwise back to results.
  if (!cartCovers(lines, occ) || !withinAvailability(parseCart(url.searchParams), rooms)) {
    throw redirect(`/${params.channelId}/rooms?${url.searchParams.toString()}`);
  }

  const nights = Math.max(1, differenceInCalendarDays(parseISO(checkout), parseISO(checkin)));
  const catalog = await getActiveExtras(params.channelId);
  return {
    nights,
    guests: partySize(occ),
    currency,
    catalog,
    selection: parseExtras(url.searchParams),
    roomLines: lines.map((l) => ({ title: l.roomTitle, rate: l.rateTitle, total: l.total })),
    roomTotal: cartCoverage(lines).total,
  };
}

export function meta() {
  return [{ title: "Enhance your stay" }];
}

// ---- small UI pieces ----

function Stepper({ qty, onDec, onInc }: { qty: number; onDec: () => void; onInc: () => void }) {
  const btn =
    "flex h-9 w-9 flex-none items-center justify-center rounded-[9px] border border-line-alt text-[18px] leading-none text-ink hover:border-accent hover:text-accent";
  return (
    <div className="flex items-center gap-3">
      <button type="button" aria-label="Decrease" onClick={onDec} className={btn}>−</button>
      <span className="min-w-[20px] text-center text-[15px] font-semibold">{qty}</span>
      <button type="button" aria-label="Increase" onClick={onInc} className={btn}>+</button>
    </div>
  );
}

const stripe = "repeating-linear-gradient(135deg,#efe7da,#efe7da 11px,#e7ddcc 11px,#e7ddcc 22px)";

export default function Extras({ loaderData, params }: Route.ComponentProps) {
  const { nights, guests, currency, catalog, roomLines, roomTotal } = loaderData;
  const { currency: ctxCurrency } = useProperty();
  const cur = ctxCurrency || currency;
  const tr = useT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [sel, setSel] = useState<ExtraSelection[]>(loaderData.selection);
  const [modalId, setModalId] = useState<string | null>(null);

  const find = (id: string) => sel.find((s) => s.id === id);
  const setQty = (id: string, qty: number) =>
    setSel((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (qty > 0) next.push({ id, qty });
      return next;
    });
  const removeSel = (id: string) => setSel((prev) => prev.filter((s) => s.id !== id));
  const commit = (entry: ExtraSelection) =>
    setSel((prev) => [...prev.filter((s) => s.id !== entry.id), entry]);

  const lines = resolveExtras(catalog, sel, nights, guests);
  const extrasSum = lines.reduce((s, l) => s + l.amount, 0);
  const total = Math.round((roomTotal + extrasSum) * 100) / 100;

  const go = (skip: boolean) => {
    const next = new URLSearchParams(searchParams);
    const serialized = serializeExtras(skip ? [] : sel);
    if (serialized) next.set("extras", serialized);
    else next.delete("extras");
    navigate(`/${params.channelId}/checkout?${next.toString()}`);
  };

  const modalExtra = catalog.find((e) => e.id === modalId) ?? null;

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-9">
      <Link
        to={`/${params.channelId}/rooms?${searchParams.toString()}`}
        className="mb-[18px] inline-block text-sm font-semibold text-muted hover:text-accent"
      >
        ← {tr.t("allRooms")}
      </Link>
      <h1 className="mb-2 font-serif text-[38px] font-medium tracking-[-0.02em]">{tr.t("enhanceTitle")}</h1>
      <p className="mb-7 text-[15px] text-secondary">{tr.t("enhanceIntro")}</p>

      <div className="flex flex-wrap items-start gap-9">
        <div className="min-w-[340px] flex-[1.6]">
          {catalog.length === 0 ? (
            <div className="rounded-[16px] border border-line bg-surface p-6 text-[14px] text-secondary">
              No extras available for this stay.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              {catalog.map((e) => (
                <ExtraCard
                  key={e.id}
                  extra={e}
                  currency={cur}
                  nights={nights}
                  guests={guests}
                  selection={find(e.id)}
                  onAdd={() => setQty(e.id, (find(e.id)?.qty ?? 0) + 1)}
                  onInc={() => setQty(e.id, (find(e.id)?.qty ?? 0) + 1)}
                  onDec={() => setQty(e.id, (find(e.id)?.qty ?? 0) - 1)}
                  onConfigure={() => setModalId(e.id)}
                  onRemove={() => removeSel(e.id)}
                  tr={tr}
                />
              ))}
            </div>
          )}
        </div>

        {/* summary */}
        <aside
          className="sticky top-24 min-w-[300px] flex-1 rounded-[18px] border border-line bg-surface p-6"
          style={{ boxShadow: "var(--shadow-sticky)" }}
        >
          <h3 className="mb-4 font-serif text-[21px] font-semibold">{tr.p("yourStayRooms", roomLines.length)}</h3>
          <div className="flex flex-col gap-3 border-b border-divider pb-4">
            {roomLines.map((l, i) => (
              <div key={i} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[14.5px] font-semibold">{l.title}</div>
                  <div className="text-[12.5px] text-muted-2">{l.rate}</div>
                </div>
                <span className="whitespace-nowrap text-[14px] font-semibold">{formatMoney(l.total, cur)}</span>
              </div>
            ))}
          </div>

          {lines.length > 0 && (
            <div className="flex flex-col gap-2.5 border-b border-divider py-4">
              <div className="text-[12px] font-semibold uppercase tracking-wide text-muted-2">{tr.t("extrasLabel")}</div>
              {lines.map((l) => (
                <div key={l.id} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium">
                      {l.optionName ? `${l.name} · ${l.optionName}` : l.name}
                      {l.qty > 1 ? ` ×${l.qty}` : ""}
                    </div>
                    {l.infoLine && <div className="text-[12px] text-muted-2">{l.infoLine}</div>}
                  </div>
                  <span className="whitespace-nowrap text-[13.5px] font-semibold">{formatMoney(l.amount, cur)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-baseline justify-between py-4">
            <span className="text-[16px] font-semibold">{tr.t("total")}</span>
            <span className="font-serif text-[28px] font-semibold">{formatMoney(total, cur)}</span>
          </div>

          <button
            type="button"
            onClick={() => go(false)}
            className="w-full rounded-[12px] bg-accent py-[14px] text-[16px] font-semibold text-white transition-colors hover:bg-accent-deep"
          >
            {tr.t("continueToDetails")}
          </button>
          <button
            type="button"
            onClick={() => go(true)}
            className="mt-2.5 w-full rounded-[10px] py-2.5 text-center text-[14px] font-semibold text-muted hover:text-accent"
          >
            {tr.t("skipForNow")}
          </button>
        </aside>
      </div>

      {modalExtra && (
        <ConfigureModal
          extra={modalExtra}
          currency={cur}
          nights={nights}
          guests={guests}
          current={find(modalExtra.id)}
          onClose={() => setModalId(null)}
          onCommit={(entry) => {
            commit(entry);
            setModalId(null);
          }}
          onRemove={() => {
            removeSel(modalExtra.id);
            setModalId(null);
          }}
          tr={tr}
        />
      )}
    </main>
  );
}

type Tr = ReturnType<typeof useT>;

function ExtraCard({
  extra,
  currency,
  nights,
  guests,
  selection,
  onAdd,
  onInc,
  onDec,
  onConfigure,
  onRemove,
  tr,
}: {
  extra: Extra;
  currency: string;
  nights: number;
  guests: number;
  selection?: ExtraSelection;
  onAdd: () => void;
  onInc: () => void;
  onDec: () => void;
  onConfigure: () => void;
  onRemove: () => void;
  tr: Tr;
}) {
  const configurable = isConfigurable(extra);
  const has = !!selection;
  const lines = resolveExtras(extra ? [extra] : [], selection ? [selection] : [], nights, guests);
  const line = lines[0];

  return (
    <div
      className="flex flex-col overflow-hidden rounded-[16px] border bg-surface"
      style={{ borderColor: has ? "var(--accent)" : "var(--line)" }}
    >
      <div className="h-[120px] w-full flex-none" style={{ background: stripe }} />
      <div className="flex flex-1 flex-col p-5">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <h3 className="font-serif text-[19px] font-semibold">{extra.name}</h3>
          <span className="whitespace-nowrap text-[14px] font-semibold text-secondary">
            {configurable
              ? `${tr.t("from")} ${formatMoney(fromPrice(extra), currency)}`
              : formatMoney(extra.price ?? 0, currency)}
            <span className="text-[12px] font-normal text-muted-2"> · {UNIT_LABEL[extra.unit]}</span>
          </span>
        </div>
        {extra.desc && <p className="mb-4 text-[13.5px] leading-[1.5] text-muted">{extra.desc}</p>}

        <div className="mt-auto">
          {/* configured / added summary */}
          {has && (configurable || extra.fields?.length) ? (
            <div className="rounded-[12px] border border-accent bg-accent-soft p-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[14px] font-semibold">
                  {line?.optionName ?? extra.name}
                  {line && line.qty > 1 ? ` ×${line.qty}` : ""}
                </span>
                <span className="text-[14px] font-semibold">{line ? formatMoney(line.amount, currency) : ""}</span>
              </div>
              {line?.infoLine && <div className="mt-0.5 text-[12.5px] text-muted-2">{line.infoLine}</div>}
              <div className="mt-2 flex items-center gap-3 text-[13px] font-semibold">
                <button type="button" onClick={onConfigure} className="text-accent hover:underline">{tr.t("editExtra")}</button>
                <button type="button" onClick={onRemove} className="text-[#c0392b] hover:underline">{tr.t("removeExtra")}</button>
              </div>
            </div>
          ) : configurable || extra.fields?.length ? (
            <button
              type="button"
              onClick={onConfigure}
              className="w-full rounded-[10px] border border-line-alt bg-surface py-2.5 text-[14px] font-semibold text-ink hover:border-accent hover:text-accent"
            >
              {configurable ? tr.t("chooseOption") : tr.t("add")}
            </button>
          ) : has ? (
            <div className="flex items-center justify-between">
              <Stepper qty={selection!.qty} onDec={onDec} onInc={onInc} />
              <span className="text-[14px] font-semibold">{line ? formatMoney(line.amount, currency) : ""}</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={onAdd}
              className="w-full rounded-[10px] border border-line-alt bg-surface py-2.5 text-[14px] font-semibold text-ink hover:border-accent hover:text-accent"
            >
              + {tr.t("add")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ConfigureModal({
  extra,
  currency,
  nights,
  guests,
  current,
  onClose,
  onCommit,
  onRemove,
  tr,
}: {
  extra: Extra;
  currency: string;
  nights: number;
  guests: number;
  current?: ExtraSelection;
  onClose: () => void;
  onCommit: (entry: ExtraSelection) => void;
  onRemove: () => void;
  tr: Tr;
}) {
  const configurable = isConfigurable(extra);
  const [optionId, setOptionId] = useState<string | undefined>(
    current?.optionId ?? (configurable ? undefined : undefined),
  );
  const [qty, setQty] = useState(current?.qty ?? 1);
  const [info, setInfo] = useState<Record<string, string>>(current?.info ?? {});

  const draft: ExtraSelection = { id: extra.id, optionId, qty, info };
  const line = resolveExtras([extra], optionId || !configurable ? [draft] : [], nights, guests)[0];

  const optionOk = configurable ? !!optionId : true;
  const fieldsOk = (extra.fields ?? []).every((f) => !f.required || (info[f.id] ?? "").trim());
  const canAdd = optionOk && fieldsOk;
  const already = !!current;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(42,37,33,0.55)" }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-[480px] flex-col overflow-hidden rounded-[20px] bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-[120px] w-full flex-none" style={{ background: stripe }} />
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mb-1 flex items-start justify-between gap-3">
            <h2 className="font-serif text-[22px] font-semibold">{extra.name}</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="text-[22px] leading-none text-muted-2 hover:text-ink">×</button>
          </div>
          {extra.desc && <p className="mb-5 text-[14px] leading-[1.5] text-muted">{extra.desc}</p>}

          {configurable && (
            <div className="mb-5 flex flex-col gap-2.5">
              <div className="text-[12px] font-semibold uppercase tracking-wide text-muted-2">{tr.t("chooseOption")}</div>
              {extra.options!.map((o) => {
                const active = o.id === optionId;
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => setOptionId(o.id)}
                    className="flex items-start gap-3 rounded-[12px] border-[1.5px] p-3.5 text-left"
                    style={{ borderColor: active ? "var(--accent)" : "#e8e0d5", background: active ? "var(--accent-soft)" : "#fff" }}
                  >
                    <span
                      className="mt-0.5 h-[18px] w-[18px] flex-none rounded-full border-2"
                      style={{ borderColor: active ? "var(--accent)" : "#cfc4b2", background: active ? "var(--accent)" : "transparent" }}
                    />
                    <span className="flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="text-[15px] font-semibold">{o.name}</span>
                        <span className="whitespace-nowrap text-[14.5px] font-semibold">
                          {formatMoney(o.price, currency)}
                          <span className="text-[12px] font-normal text-muted-2"> · {UNIT_LABEL[o.unit ?? extra.unit]}</span>
                        </span>
                      </span>
                      {o.desc && <span className="mt-0.5 block text-[13px] text-muted">{o.desc}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {(optionOk || !configurable) && (
            <div className="mb-5 flex items-center justify-between">
              <span className="text-[14px] font-semibold text-secondary">{tr.t("quantity")}</span>
              <Stepper qty={qty} onDec={() => setQty((q) => Math.max(1, q - 1))} onInc={() => setQty((q) => q + 1)} />
            </div>
          )}

          {extra.fields?.length ? (
            <div className="mb-1">
              <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-2">
                {extra.infoTitle || "Details"}
              </div>
              <div className="flex flex-col gap-3">
                {extra.fields.map((f) => (
                  <label key={f.id} className="block text-[13px] font-semibold text-secondary">
                    {f.label}
                    {f.required ? " *" : ""}
                    <input
                      value={info[f.id] ?? ""}
                      onChange={(e) => setInfo((prev) => ({ ...prev, [f.id]: e.target.value }))}
                      placeholder={f.placeholder}
                      className="mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[11px] text-[15px] text-ink outline-none focus:border-accent"
                    />
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex-none border-t border-divider p-5">
          {!canAdd && <p className="mb-2.5 text-[12.5px] text-[#b08968]">{tr.t("selectToContinue")}</p>}
          <div className="flex items-center justify-between gap-3">
            <span className="font-serif text-[22px] font-semibold">{line ? formatMoney(line.amount, currency) : "—"}</span>
            <div className="flex items-center gap-3">
              {already && (
                <button type="button" onClick={onRemove} className="text-[13px] font-semibold text-[#c0392b] hover:underline">
                  {tr.t("removeExtra")}
                </button>
              )}
              <button
                type="button"
                disabled={!canAdd}
                onClick={() => canAdd && onCommit({ id: extra.id, optionId, qty, info })}
                className="rounded-[10px] bg-accent px-5 py-2.5 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-50"
              >
                {already ? tr.t("updateBooking") : tr.t("addToBooking")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
