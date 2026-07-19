// Package-voucher redemption wizard — the guest books their prepaid stay
// online: pick a check-in date (only dates the hotel's package rules allow AND
// with live availability), pick a room type, leave contact details. The stay
// is already paid, so there's no payment step.
import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";
import { format, parseISO, addDays } from "date-fns";

import type { Route } from "./+types/voucher-book";
import { useProperty } from "~/lib/booking-context";
import { useT } from "~/lib/i18n";
import { langFromRequest } from "~/lib/content";
import { resolvePropertyId } from "~/lib/properties.server";
import { getVoucherByCode } from "~/lib/vouchers.server";
import { displayStatus, normalizeVoucherCode } from "~/lib/vouchers";
import { packageCheckinOptions, redeemPackageVoucher } from "~/lib/voucher-redeem.server";
import { getRooms } from "~/lib/catalog.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  const pid = await resolvePropertyId(params.channelId);
  const code = normalizeVoucherCode(params.code);
  const v = await getVoucherByCode(pid, code);
  if (!v || v.kind !== "package" || !v.product.package) throw redirect(`/${params.channelId}/voucher/${params.code}`);
  if (displayStatus(v) !== "active") throw redirect(`/${params.channelId}/voucher/${params.code}`);

  const [options, rooms] = await Promise.all([
    packageCheckinOptions(pid, v.product.package, v.expiresAt),
    getRooms(pid),
  ]);
  // Strict public projection.
  return {
    code: v.code,
    title: v.product.title,
    nights: v.product.package.nights,
    adults: v.product.package.adults,
    children: v.product.package.children ?? 0,
    recipientName: v.gift?.recipientName,
    options,
    rooms: v.product.package.roomIds
      .map((id) => rooms.find((r) => r.id === id))
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .map((r) => ({ id: r.id, title: r.title, image: r.images?.[0], description: r.description })),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const pid = await resolvePropertyId(params.channelId);
  const v = await getVoucherByCode(pid, normalizeVoucherCode(params.code));
  if (!v) return { error: "Voucher not found." };

  const form = await request.formData();
  const checkin = String(form.get("checkin") ?? "");
  const roomId = String(form.get("roomId") ?? "");
  const guest = {
    firstName: String(form.get("firstName") ?? "").trim(),
    lastName: String(form.get("lastName") ?? "").trim(),
    email: String(form.get("email") ?? "").trim(),
    phone: String(form.get("phone") ?? "").trim(),
    requests: String(form.get("requests") ?? "").trim() || undefined,
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkin)) return { error: "Pick a check-in date." };
  if (!roomId) return { error: "Pick a room." };
  if (!guest.firstName || !guest.lastName) return { error: "Enter the guest's name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest.email)) return { error: "Enter a valid email address." };

  const result = await redeemPackageVoucher({
    pid,
    voucher: v,
    checkin,
    roomId,
    guest,
    origin: new URL(request.url).origin,
    lang: langFromRequest(request),
  });
  if (!result.ok) return { error: result.message };
  if (result.booking.status === "failed") {
    // Push failed (retryable in admin) — don't land the guest on a success page.
    return {
      error:
        "Your voucher was accepted but the booking couldn't be confirmed automatically — the hotel has been notified and will confirm it shortly.",
    };
  }
  // The generic confirmation page reconstructs from cart URL params (rate
  // pricing) — wrong for a package. The voucher page shows the booked stay.
  return redirect(`/${params.channelId}/voucher/${v.code}?booked=1`);
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData ? `Book — ${loaderData.title}` : "Book your stay" }];
}

export default function VoucherBook({ loaderData, actionData, params }: Route.ComponentProps) {
  const { code, title, nights, adults, children, recipientName, options, rooms } = loaderData;
  const tr = useT();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [checkin, setCheckin] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const { locale } = tr;
  const input =
    "mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface px-3.5 py-2.5 text-[15px] text-ink outline-none focus:border-accent";
  const stripe = "repeating-linear-gradient(135deg,#efe7da,#efe7da 10px,#e7ddcc 10px,#e7ddcc 20px)";

  const selected = options.find((o) => o.date === checkin);
  const availableRooms = selected ? rooms.filter((r) => selected.roomIds.includes(r.id)) : [];
  const checkoutISO = checkin ? format(addDays(parseISO(checkin), nights), "yyyy-MM-dd") : null;

  return (
    <main className="mx-auto max-w-[820px] px-7 pb-[72px] pt-8">
      <Link
        to={`/${params.channelId}/voucher/${code}`}
        className="mb-5 inline-block text-sm font-semibold text-muted hover:text-accent"
      >
        ← {tr.t("voucherCodeLabel")} {code}
      </Link>
      <h1 className="mb-2 font-serif text-[34px] font-medium tracking-[-0.02em]">{tr.t("voucherRedeemTitle")}</h1>
      <p className="mb-8 max-w-[560px] text-[16px] leading-[1.6] text-secondary">
        {tr.t("voucherRedeemIntro", { title, nights: String(nights) })}
      </p>

      <Form method="post" className="flex flex-col gap-8">
        {/* 1 · date */}
        <section>
          <h2 className="mb-3 font-serif text-[20px] font-semibold">1 · {tr.t("voucherPickDate")}</h2>
          {options.length === 0 ? (
            <p className="rounded-[12px] border border-line bg-surface p-5 text-[14.5px] text-secondary">
              {tr.t("voucherNoDates")}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2.5">
                {options.map((o) => {
                  const d = parseISO(o.date);
                  const active = checkin === o.date;
                  return (
                    <button
                      key={o.date}
                      type="button"
                      onClick={() => {
                        setCheckin(o.date);
                        setRoomId(null);
                      }}
                      className={`rounded-[12px] border px-4 py-2.5 text-center text-[13.5px] font-semibold transition-colors ${
                        active ? "border-accent bg-accent text-white" : "border-line-alt bg-surface text-secondary hover:border-accent"
                      }`}
                    >
                      <span className="block text-[11px] font-medium uppercase opacity-80">
                        {format(d, "EEE", { locale })}
                      </span>
                      {format(d, "d MMM yyyy", { locale })}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-[12px] text-faint">{tr.t("voucherShowingNext")}</p>
              {checkin && checkoutISO && (
                <p className="mt-2 text-[13.5px] font-semibold text-accent-deep">
                  {format(parseISO(checkin), "EEE d MMM", { locale })} → {format(parseISO(checkoutISO), "EEE d MMM yyyy", { locale })} ·{" "}
                  {tr.p("night", nights)} · {tr.p("adult", adults)}
                  {children ? ` + ${tr.p("child", children)}` : ""}
                </p>
              )}
            </>
          )}
          <input type="hidden" name="checkin" value={checkin ?? ""} />
        </section>

        {/* 2 · room */}
        {checkin && (
          <section>
            <h2 className="mb-3 font-serif text-[20px] font-semibold">2 · {tr.t("voucherPickRoom")}</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {availableRooms.map((r) => {
                const active = roomId === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setRoomId(r.id)}
                    className={`overflow-hidden rounded-[14px] border-2 text-left transition-colors ${
                      active ? "border-accent" : "border-line hover:border-accent/50"
                    }`}
                  >
                    <div className="h-[120px]" style={{ background: stripe }}>
                      {r.image && <img src={r.image} alt="" className="h-full w-full object-cover" />}
                    </div>
                    <div className="bg-surface p-4">
                      <div className="font-semibold">{r.title}</div>
                      {r.description && <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted">{r.description}</p>}
                    </div>
                  </button>
                );
              })}
            </div>
            <input type="hidden" name="roomId" value={roomId ?? ""} />
          </section>
        )}

        {/* 3 · guest */}
        {checkin && roomId && (
          <section>
            <h2 className="mb-3 font-serif text-[20px] font-semibold">3 · {tr.t("voucherYourDetails")}</h2>
            <div className="grid grid-cols-1 gap-4 rounded-[14px] border border-line bg-surface p-5 sm:grid-cols-2">
              <label className="block text-[13px] font-semibold text-secondary">
                {tr.t("firstName")}
                <input name="firstName" required defaultValue={recipientName?.split(/\s+/)[0] ?? ""} className={input} />
              </label>
              <label className="block text-[13px] font-semibold text-secondary">
                {tr.t("lastName")}
                <input name="lastName" required defaultValue={recipientName?.split(/\s+/).slice(1).join(" ") ?? ""} className={input} />
              </label>
              <label className="block text-[13px] font-semibold text-secondary">
                {tr.t("email")}
                <input name="email" type="email" required className={input} />
              </label>
              <label className="block text-[13px] font-semibold text-secondary">
                {tr.t("phone")}
                <input name="phone" className={input} />
              </label>
              <label className="block text-[13px] font-semibold text-secondary sm:col-span-2">
                {tr.t("specialRequests")}
                <textarea name="requests" rows={2} className={`${input} resize-y`} />
              </label>
            </div>
          </section>
        )}

        {actionData?.error && (
          <p className="rounded-[10px] border border-red-200 bg-red-50 px-4 py-2.5 text-[13.5px] text-red-700">
            {actionData.error}
          </p>
        )}
        {checkin && roomId && (
          <div>
            <button
              type="submit"
              disabled={busy}
              className="rounded-[12px] bg-accent px-8 py-4 text-[16px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
            >
              {busy ? "…" : tr.t("voucherConfirm")}
            </button>
            <p className="mt-2 text-[12.5px] text-muted">{tr.t("voucherNoPayment")}</p>
          </div>
        )}
      </Form>
    </main>
  );
}
