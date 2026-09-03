import { getPageText } from "~/lib/overrides.server";

import { langFromRequest } from "~/lib/content";
import { useState } from "react";
import { Link, redirect, useNavigate, useSearchParams } from "react-router";

import type { Route } from "./+types/extras";
import { pageMeta } from "~/lib/page-meta";
import { useProperty } from "~/lib/booking-context";
import { parseCart } from "~/lib/cart";
import { resolveCartByOccupancy } from "~/lib/catalog.server";
import { getActiveExtras } from "~/lib/extras.server";
import {
  UNIT_LABEL,
  extraEligible,
  fromPrice,
  isConfigurable,
  parseExtrasState,
  resolveExtras,
  scopeOf,
  serializeExtrasState,
  setExtrasLine,
  type Extra,
  type ExtraSelection,
} from "~/lib/extras";
import { formatMoney } from "~/lib/money";
import { partySize } from "~/lib/occupancy";
import { useT } from "~/lib/i18n";
import { useBase, useHome } from "~/lib/base";
import { requireDatedStay } from "~/lib/dated-stay.server";
import { cartTokenMap } from "~/lib/cart-tokens";
import { isTagged } from "~/lib/tracking-settings";
import { TrackCart } from "~/components/tracking-events";
import { useSlots } from "~/components/site-style";
import { cx } from "~/lib/site-style";

export async function loader({ params, request }: Route.LoaderArgs) {
  const { pid, base, url, checkin, checkout, occ, currency, nights, settings } =
    await requireDatedStay(params.channelId, request);

  const sp = url.searchParams.toString();
  const lineIndex = Number(url.searchParams.get("line"));
  if (!Number.isInteger(lineIndex) || lineIndex < 0) throw redirect(`${base}/rooms?${sp}`);

  const cartLines = await resolveCartByOccupancy(
    pid,
    { checkin, checkout, currency },
    parseCart(url.searchParams),
    { adults: occ.adults, childrenAge: occ.childrenAge },
  );
  const line = cartLines[lineIndex];
  if (!line) throw redirect(`${base}/rooms?${sp}`);

  // Room-scoped extras eligible for this room+rate; booking-scoped extras are
  // offered once, on the first room's step.
  const catalog = await getActiveExtras(pid);
  const roomExtras = catalog.filter((e) => scopeOf(e) === "room" && extraEligible(e, line.roomId, line.rateId));
  const isFirst = lineIndex === 0;
  const bookingExtras = isFirst ? catalog.filter((e) => scopeOf(e) === "booking") : [];
  // Nothing to offer for this room → skip the step entirely.
  if (roomExtras.length === 0 && bookingExtras.length === 0) {
    throw redirect(`${base}/rooms?${sp}`);
  }

  const state = parseExtrasState(url.searchParams);
  const text = await getPageText(pid, "extras", langFromRequest(request));
  return {
    // No view event here — extras aren't the product. This step reports the
    // cart only, because the add that got the guest here happened on the room
    // page and this is the first loader that sees the new `sel`.
    tracking: isTagged(settings.analytics)
      ? {
          sel: url.searchParams.get("sel") ?? "",
          cart: cartTokenMap(cartLines),
          stay: {
            currency,
            checkin,
            checkout,
            nights,
            adults: occ.adults,
            children: occ.childrenAge?.length ?? 0,
          },
        }
      : null,
    lineIndex,
    nights,
    currency,
    text,
    // Per-room extras price for this room's occupancy; booking extras for the party.
    roomGuests: line.occupancy.adults + line.occupancy.children,
    party: partySize(occ),
    roomTitle: line.roomTitle,
    rateTitle: line.rateTitle,
    roomTotal: line.total,
    roomExtras,
    bookingExtras,
    roomSelection: state.lines[lineIndex] ?? [],
    bookingSelection: state.booking,
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageMeta(matches, { titleKey: "metaExtras", noindex: true });
}

// ---- small UI pieces ----

function Stepper({ qty, onDec, onInc }: { qty: number; onDec: () => void; onInc: () => void }) {
  const btn =
    "flex h-9 w-9 flex-none items-center justify-center rounded-chip border border-line-alt text-title-sm leading-none text-ink hover:border-accent hover:text-accent";
  return (
    <div className="flex items-center gap-3">
      <button type="button" aria-label="Decrease" onClick={onDec} className={btn}>−</button>
      <span className="min-w-[20px] text-center text-body-lg font-semibold">{qty}</span>
      <button type="button" aria-label="Increase" onClick={onInc} className={btn}>+</button>
    </div>
  );
}

const stripe = "repeating-linear-gradient(135deg,#efe7da,#efe7da 11px,#e7ddcc 11px,#e7ddcc 22px)";

type Tr = ReturnType<typeof useT>;

/** One selectable group of extras (a room's add-ons, or the stay-wide set),
 *  owning its own configure-modal state. Mutates the parent's selection list. */
function ExtraSection({
  title,
  subtitle,
  extras,
  sel,
  setSel,
  currency,
  nights,
  guests,
  tr,
}: {
  title: string;
  subtitle?: string;
  extras: Extra[];
  sel: ExtraSelection[];
  setSel: React.Dispatch<React.SetStateAction<ExtraSelection[]>>;
  currency: string;
  nights: number;
  guests: number;
  tr: Tr;
}) {
  const [modalId, setModalId] = useState<string | null>(null);
  const find = (id: string) => sel.find((s) => s.id === id);
  const setQty = (id: string, qty: number) =>
    setSel((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (qty > 0) next.push({ id, qty });
      return next;
    });
  const removeSel = (id: string) => setSel((prev) => prev.filter((s) => s.id !== id));
  const commit = (entry: ExtraSelection) => setSel((prev) => [...prev.filter((s) => s.id !== entry.id), entry]);
  const modalExtra = extras.find((e) => e.id === modalId) ?? null;

  if (extras.length === 0) return null;
  return (
    <section className="mb-9">
      <h2 className="mb-1 font-serif text-title-lg font-medium tracking-[-0.01em]">{title}</h2>
      {subtitle && <p className="mb-4 text-body text-secondary">{subtitle}</p>}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        {extras.map((e) => (
          <ExtraCard
            key={e.id}
            extra={e}
            currency={currency}
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
      {modalExtra && (
        <ConfigureModal
          extra={modalExtra}
          currency={currency}
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
    </section>
  );
}

export default function Extras({ loaderData, params }: Route.ComponentProps) {
  const base = useBase();
  const home = useHome();
  const { tracking, lineIndex, nights, currency, roomGuests, party, roomTitle, rateTitle, roomTotal, roomExtras, bookingExtras, text } =
    loaderData;
  const { currency: ctxCurrency } = useProperty();
  const cur = ctxCurrency || currency;
  const tr = useT();
  const s = useSlots();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [roomSel, setRoomSel] = useState<ExtraSelection[]>(loaderData.roomSelection);
  const [bookingSel, setBookingSel] = useState<ExtraSelection[]>(loaderData.bookingSelection);

  const roomLines = resolveExtras(roomExtras, roomSel, nights, roomGuests);
  const bookingLines = resolveExtras(bookingExtras, bookingSel, nights, party);
  const allLines = [...roomLines, ...bookingLines];
  const extrasSum = allLines.reduce((s, l) => s + l.amount, 0);

  const go = (skip: boolean) => {
    let state = setExtrasLine(parseExtrasState(searchParams), lineIndex, skip ? [] : roomSel);
    if (bookingExtras.length) state = { ...state, booking: skip ? [] : bookingSel };
    const next = new URLSearchParams(searchParams);
    next.delete("line");
    const xt = serializeExtrasState(state);
    if (xt) next.set("xt", xt);
    else next.delete("xt");
    navigate(`${base}/rooms?${next.toString()}`);
  };

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-9">
      {tracking && <TrackCart sel={tracking.sel} lines={tracking.cart} stay={tracking.stay} />}
      <Link
        to={`${base}/rooms?${searchParams.toString()}`}
        className="mb-[18px] inline-block text-sm font-semibold text-muted hover:text-accent"
      >
        ← {tr.t("allRooms")}
      </Link>

      <div className="flex flex-wrap items-start gap-9">
        <div className="min-w-[340px] flex-[1.6]">
          <ExtraSection
            title={text.heading.replaceAll("{room}", roomTitle)}
            subtitle={text.intro}
            extras={roomExtras}
            sel={roomSel}
            setSel={setRoomSel}
            currency={cur}
            nights={nights}
            guests={roomGuests}
            tr={tr}
          />
          <ExtraSection
            title={text.stayTitle}
            extras={bookingExtras}
            sel={bookingSel}
            setSel={setBookingSel}
            currency={cur}
            nights={nights}
            guests={party}
            tr={tr}
          />
        </div>

        {/* summary */}
        <aside
          className={cx("sticky top-24 min-w-[300px] flex-1", s.strip, "p-6")}
          style={{ boxShadow: "var(--shadow-sticky)" }}
        >
          <h3 className="mb-4 font-serif text-title-md font-semibold">{roomTitle}</h3>
          <div className={cx("flex items-start justify-between gap-3 border-b", s.rule, "pb-4")}>
            <div className="min-w-0">
              <div className="text-label text-muted-2">{rateTitle}</div>
            </div>
            <span className="whitespace-nowrap text-body font-semibold">{formatMoney(roomTotal, cur)}</span>
          </div>

          {allLines.length > 0 && (
            <div className={cx("flex flex-col gap-2.5 border-b", s.rule, "py-4")}>
              <div className="text-label font-semibold uppercase tracking-wide text-muted-2">{text.summaryLabel}</div>
              {allLines.map((l) => (
                <div key={`${l.id}-${l.optionId ?? ""}`} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-caption font-medium">
                      {l.optionName ? `${l.name} · ${l.optionName}` : l.name}
                      {l.qty > 1 ? ` ×${l.qty}` : ""}
                    </div>
                    {l.infoLine && <div className="text-label text-muted-2">{l.infoLine}</div>}
                  </div>
                  <span className="whitespace-nowrap text-caption font-semibold">{formatMoney(l.amount, cur)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-baseline justify-between py-4">
            <span className="text-body-lg font-semibold">{text.summaryLabel}</span>
            <span className="font-serif text-title-lg font-semibold">{formatMoney(extrasSum, cur)}</span>
          </div>

          <button
            type="button"
            onClick={() => go(false)}
            className={cx("w-full", s.btnPrimary, "py-[14px] text-lead font-semibold transition-colors")}
          >
            {text.continueButton}
          </button>
          <button
            type="button"
            onClick={() => go(true)}
            className="mt-2.5 w-full rounded-control py-2.5 text-center text-body font-semibold text-muted hover:text-accent"
          >
            {text.skipButton}
          </button>
        </aside>
      </div>
    </main>
  );
}

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
  const s = useSlots();
  const configurable = isConfigurable(extra);
  const has = !!selection;
  const lines = resolveExtras(extra ? [extra] : [], selection ? [selection] : [], nights, guests);
  const line = lines[0];

  return (
    <div
      className="flex flex-col overflow-hidden rounded-panel border bg-surface"
      style={{ borderColor: has ? "var(--accent)" : "var(--line)" }}
    >
      {extra.image ? (
        <img src={extra.image} alt="" className="h-[120px] w-full flex-none object-cover" />
      ) : (
        <div className="h-[120px] w-full flex-none" style={{ background: stripe }} />
      )}
      <div className="flex flex-1 flex-col p-5">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <h3 className="font-serif text-title-sm font-semibold">{extra.name}</h3>
          <span className="whitespace-nowrap text-body font-semibold text-secondary">
            {configurable
              ? `${tr.t("from")} ${formatMoney(fromPrice(extra), currency)}`
              : formatMoney(extra.price ?? 0, currency)}
            <span className="text-label font-normal text-muted-2"> · {UNIT_LABEL[extra.unit]}</span>
          </span>
        </div>
        {extra.desc && <p className="mb-4 text-caption leading-[1.5] text-muted">{extra.desc}</p>}

        <div className="mt-auto">
          {/* configured / added summary */}
          {has && (configurable || extra.fields?.length) ? (
            <div className="rounded-card border border-accent bg-accent-soft p-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-body font-semibold">
                  {line?.optionName ?? extra.name}
                  {line && line.qty > 1 ? ` ×${line.qty}` : ""}
                </span>
                <span className="text-body font-semibold">{line ? formatMoney(line.amount, currency) : ""}</span>
              </div>
              {line?.infoLine && <div className="mt-0.5 text-label text-muted-2">{line.infoLine}</div>}
              <div className="mt-2 flex items-center gap-3 text-caption font-semibold">
                <button type="button" onClick={onConfigure} className="text-accent hover:underline">{tr.t("editExtra")}</button>
                <button type="button" onClick={onRemove} className="text-danger hover:underline">{tr.t("removeExtra")}</button>
              </div>
            </div>
          ) : configurable || extra.fields?.length ? (
            <button
              type="button"
              onClick={onConfigure}
              className={cx("w-full rounded-control border border-line-alt bg-surface py-2.5 text-body font-semibold text-ink hover:border-accent hover:text-accent")}
            >
              {configurable ? tr.t("chooseOption") : tr.t("add")}
            </button>
          ) : has ? (
            <div className="flex items-center justify-between">
              <Stepper qty={selection!.qty} onDec={onDec} onInc={onInc} />
              <span className="text-body font-semibold">{line ? formatMoney(line.amount, currency) : ""}</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={onAdd}
              className={cx("w-full rounded-control border border-line-alt bg-surface py-2.5 text-body font-semibold text-ink hover:border-accent hover:text-accent")}
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
  const s = useSlots();
  const configurable = isConfigurable(extra);
  const [optionId, setOptionId] = useState<string | undefined>(current?.optionId);
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
        className="flex max-h-[88vh] w-full max-w-[480px] flex-col overflow-hidden rounded-well bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        {extra.image ? (
          <img src={extra.image} alt="" className="h-[120px] w-full flex-none object-cover" />
        ) : (
          <div className="h-[120px] w-full flex-none" style={{ background: stripe }} />
        )}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mb-1 flex items-start justify-between gap-3">
            <h2 className="font-serif text-title-md font-semibold">{extra.name}</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="text-title-md leading-none text-muted-2 hover:text-ink">×</button>
          </div>
          {extra.desc && <p className="mb-5 text-body leading-[1.5] text-muted">{extra.desc}</p>}

          {configurable && (
            <div className="mb-5 flex flex-col gap-2.5">
              <div className="text-label font-semibold uppercase tracking-wide text-muted-2">{tr.t("chooseOption")}</div>
              {extra.options!.map((o) => {
                const active = o.id === optionId;
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => setOptionId(o.id)}
                    className="flex items-start gap-3 rounded-card border-[1.5px] p-3.5 text-left"
                    style={{ borderColor: active ? "var(--accent)" : "var(--color-line-alt)", background: active ? "var(--accent-soft)" : "var(--color-surface)" }}
                  >
                    <span
                      className="mt-0.5 h-[18px] w-[18px] flex-none rounded-full border-2"
                      style={{ borderColor: active ? "var(--accent)" : "#cfc4b2", background: active ? "var(--accent)" : "transparent" }}
                    />
                    <span className="flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="text-body-lg font-semibold">{o.name}</span>
                        <span className="whitespace-nowrap text-body font-semibold">
                          {formatMoney(o.price, currency)}
                          <span className="text-label font-normal text-muted-2"> · {UNIT_LABEL[o.unit ?? extra.unit]}</span>
                        </span>
                      </span>
                      {o.desc && <span className="mt-0.5 block text-caption text-muted">{o.desc}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {(optionOk || !configurable) && (
            <div className="mb-5 flex items-center justify-between">
              <span className="text-body font-semibold text-secondary">{tr.t("quantity")}</span>
              <Stepper qty={qty} onDec={() => setQty((q) => Math.max(1, q - 1))} onInc={() => setQty((q) => q + 1)} />
            </div>
          )}

          {extra.fields?.length ? (
            <div className="mb-1">
              <div className="mb-2 text-label font-semibold uppercase tracking-wide text-muted-2">
                {extra.infoTitle || "Details"}
              </div>
              <div className="flex flex-col gap-3">
                {extra.fields.map((f) => (
                  <label key={f.id} className="block text-caption font-semibold text-secondary">
                    {f.label}
                    {f.required ? " *" : ""}
                    <input
                      value={info[f.id] ?? ""}
                      onChange={(e) => setInfo((prev) => ({ ...prev, [f.id]: e.target.value }))}
                      placeholder={f.placeholder}
                      className={cx("mt-1.5 block w-full", s.field, "px-3.5 py-[11px] text-body-lg text-ink outline-none focus:border-accent")}
                    />
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className={cx("flex-none border-t", s.rule, "p-5")}>
          {!canAdd && <p className="mb-2.5 text-label text-caution">{tr.t("selectToContinue")}</p>}
          <div className="flex items-center justify-between gap-3">
            <span className="font-serif text-title-md font-semibold">{line ? formatMoney(line.amount, currency) : "—"}</span>
            <div className="flex items-center gap-3">
              {already && (
                <button type="button" onClick={onRemove} className="text-caption font-semibold text-danger hover:underline">
                  {tr.t("removeExtra")}
                </button>
              )}
              <button
                type="button"
                disabled={!canAdd}
                onClick={() => canAdd && onCommit({ id: extra.id, optionId, qty, info })}
                className="rounded-control bg-accent px-5 py-2.5 text-body-lg font-semibold text-on-accent hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-50"
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
