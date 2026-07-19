import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/manage";
import { fmtDate } from "~/lib/dates";
import { useProperty } from "~/lib/booking-context";
import {
  findBookingByRefAndEmail,
  getBookingsByEmail,
} from "~/lib/bookings.server";
import { displayStatus, giftBalance, normalizeVoucherCode } from "~/lib/vouchers";
import { getVoucherByCode, listVouchersByEmail } from "~/lib/vouchers.server";
import { createGuestSession, getGuestEmail, guestLogout } from "~/lib/guest-auth.server";
import { resolvePropertyId } from "~/lib/properties.server";
import { clientKey, rateLimit } from "~/lib/rate-limit.server";
import { useT } from "~/lib/i18n";
import { formatMoney } from "~/lib/money";

export async function loader({ params, request }: Route.LoaderArgs) {
  const email = await getGuestEmail(request);
  if (!email) return { authed: false as const };
  // :channelId may be a slug — resolve to the real id for booking lookups.
  const pid = await resolvePropertyId(params.channelId);
  const [bookings, vouchers] = await Promise.all([
    getBookingsByEmail(pid, email),
    listVouchersByEmail(pid, email).catch(() => []),
  ]);
  return {
    authed: true as const,
    email,
    bookings: bookings.map((b) => ({
      id: b.id,
      reference: b.reference,
      checkin: b.checkin,
      checkout: b.checkout,
      total: b.total,
      currency: b.currency,
      rooms: b.rooms.length,
    })),
    // Strict projection — the buyer's own vouchers (status derived, no payment ids).
    vouchers: vouchers.map((v) => ({
      code: v.code,
      kind: v.kind,
      status: displayStatus(v),
      title: v.product.title,
      balance: v.kind === "gift" ? giftBalance(v) : undefined,
      expiresAt: v.expiresAt,
      recipientName: v.gift?.recipientName,
    })),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const form = await request.formData();
  if (form.get("intent") === "logout") {
    return guestLogout(request, `/${params.channelId}/manage`);
  }
  const pid = await resolvePropertyId(params.channelId);
  // Throttle guessing: 8 lookups per 10 min per client. Fails open if no KV.
  if (!(await rateLimit(`manage:${pid}:${clientKey(request)}`, 8, 600))) {
    return { tooMany: true };
  }

  const reference = String(form.get("reference") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  if (!reference || !email) return { notFound: true };

  const booking = await findBookingByRefAndEmail(pid, reference, email);
  if (booking) return createGuestSession(email, `/${params.channelId}/manage`);

  // Not a booking reference — maybe a voucher code (buyers of vouchers have no
  // booking). Same rule: the code must match together with the buyer's email.
  const voucher = await getVoucherByCode(pid, normalizeVoucherCode(reference)).catch(() => null);
  if (voucher && voucher.buyer.email.trim().toLowerCase() === email.toLowerCase()) {
    return createGuestSession(email, `/${params.channelId}/manage`);
  }
  return { notFound: true };
}

export function meta() {
  return [{ title: "Manage your booking" }, { name: "robots", content: "noindex" }];
}

export default function Manage({ loaderData, actionData, params }: Route.ComponentProps) {
  const tr = useT();
  const { currency } = useProperty();
  const nav = useNavigation();
  const fmt = (d: string, f: string) => fmtDate(d, f, tr.locale);

  if (!loaderData.authed) {
    return (
      <ManageLogin
        params={params}
        submitting={nav.state === "submitting"}
        notFound={Boolean(actionData && "notFound" in actionData && actionData.notFound)}
        tooMany={Boolean(actionData && "tooMany" in actionData && actionData.tooMany)}
      />
    );
  }

  const { bookings, vouchers } = loaderData;
  const statusChip: Record<string, string> = {
    active: "bg-[#e8f0e6] text-[#3f7a52]",
    redeemed: "bg-chip text-muted",
    cancelled: "bg-[#fbe9e7] text-[#c0392b]",
    expired: "bg-[#fbe9e7] text-[#c0392b]",
  };

  return (
    <main className="mx-auto max-w-[760px] px-7 pb-20 pt-12">
      <div className="mb-7 flex items-center justify-between gap-4">
        <h1 className="font-serif text-[34px] font-medium tracking-[-0.02em]">
          {tr.t("yourBookings")}
        </h1>
        <Form method="post">
          <button
            type="submit"
            name="intent"
            value="logout"
            className="text-[13px] font-semibold text-muted hover:text-accent"
          >
            {tr.t("signOut")}
          </button>
        </Form>
      </div>

      {bookings.length === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-6 text-[15px] text-secondary">
          {tr.t("noBookingsForEmail")}
        </div>
      ) : (
        <div className="overflow-hidden rounded-[16px] border border-line bg-surface">
          {bookings.map((b, i) => (
            <Link
              key={b.id}
              to={`/${params.channelId}/manage/${b.id}`}
              className={`flex items-center justify-between gap-4 px-6 py-5 hover:bg-field-hover ${
                i > 0 ? "border-t border-divider" : ""
              }`}
            >
              <div className="min-w-0">
                <div className="font-serif text-[19px] font-semibold">
                  {fmt(b.checkin, "EEE d MMM")} — {fmt(b.checkout, "EEE d MMM yyyy")}
                </div>
                <div className="mt-1 text-[13px] text-muted-2">
                  {tr.t("reference")} {b.reference} · {tr.p("room", b.rooms)}
                </div>
              </div>
              <div className="flex flex-none items-center gap-4">
                <span className="font-serif text-[18px] font-semibold">
                  {formatMoney(b.total, b.currency || currency)}
                </span>
                <span className="text-[13px] font-semibold text-accent">{tr.t("view")} →</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {vouchers.length > 0 && (
        <>
          <h2 className="mb-4 mt-10 font-serif text-[24px] font-semibold tracking-[-0.01em]">
            {tr.t("manageVouchersTitle")}
          </h2>
          <div className="overflow-hidden rounded-[16px] border border-line bg-surface">
            {vouchers.map((v, i) => (
              <Link
                key={v.code}
                to={`/${params.channelId}/manage/voucher/${v.code}`}
                className={`flex items-center justify-between gap-4 px-6 py-5 hover:bg-field-hover ${
                  i > 0 ? "border-t border-divider" : ""
                }`}
              >
                <div className="min-w-0">
                  <div className="font-serif text-[19px] font-semibold">{v.title}</div>
                  <div className="mt-1 text-[13px] text-muted-2">
                    {v.code}
                    {v.recipientName ? ` · ${tr.t("manageVoucherFor", { name: v.recipientName })}` : ""}
                    {v.balance != null ? ` · ${tr.t("voucherBalance")}: ${formatMoney(v.balance, currency)}` : ""}
                  </div>
                </div>
                <div className="flex flex-none items-center gap-4">
                  <span
                    className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${statusChip[v.status] ?? "bg-chip text-muted"}`}
                  >
                    {tr.t(`voucherStatus_${v.status}`)}
                  </span>
                  <span className="text-[13px] font-semibold text-accent">{tr.t("view")} →</span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function ManageLogin({
  submitting,
  notFound,
  tooMany,
}: {
  params: { channelId: string };
  submitting: boolean;
  notFound: boolean;
  tooMany: boolean;
}) {
  const tr = useT();
  const inputCls =
    "mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[13px] text-[15px] text-ink outline-none focus:border-accent";

  return (
    <main className="mx-auto max-w-[460px] px-7 pb-20 pt-16">
      <h1 className="mb-2 font-serif text-[34px] font-medium tracking-[-0.02em]">
        {tr.t("manageTitle")}
      </h1>
      <p className="mb-7 text-[15px] leading-[1.6] text-secondary">{tr.t("manageIntro")}</p>

      <Form
        method="post"
        className="flex flex-col gap-4 rounded-[16px] border border-line bg-surface p-6"
      >
        <label className="block text-[13px] font-semibold text-secondary">
          {tr.t("manageRefOrCode")}
          <input name="reference" placeholder="ABC123 / RP-XXXX-XXXX" className={inputCls} autoComplete="off" />
        </label>
        <label className="block text-[13px] font-semibold text-secondary">
          {tr.t("emailAddress")}
          <input name="email" type="email" placeholder="you@email.com" className={inputCls} />
        </label>
        {tooMany ? (
          <p className="text-[13px] text-red-600">{tr.t("manageTooMany")}</p>
        ) : (
          notFound && <p className="text-[13px] text-red-600">{tr.t("manageNotFound")}</p>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="mt-1 w-full rounded-[12px] bg-accent py-[14px] text-[16px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:opacity-60"
        >
          {tr.t("findBooking")}
        </button>
      </Form>
    </main>
  );
}
