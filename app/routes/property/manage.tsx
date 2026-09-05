import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/manage";
import { pageMeta } from "~/lib/page-meta";
import { fmtDate } from "~/lib/dates";
import { useProperty } from "~/lib/booking-context";
import {
  findBookingByRefAndEmail,
  getBookingsByEmail,
} from "~/lib/bookings.server";
import { displayStatus, giftBalance, normalizeVoucherCode } from "~/lib/vouchers";
import { getVoucherByCode, listVouchersByEmail } from "~/lib/vouchers.server";
import {
  createGuestMagicToken,
  createGuestSession,
  getGuestSession,
  guestLoginDecision,
  guestLogout,
  sessionCanSee,
} from "~/lib/guest-auth.server";
import { sendGuestPortalLink } from "~/lib/email.server";

import { clientKey, rateLimit } from "~/lib/rate-limit.server";
import { useT } from "~/lib/i18n";
import { formatMoney } from "~/lib/money";
import { basePath, useBase } from "~/lib/base";
import { resolveRequestProperty } from "~/lib/property-scope.server";
import { useSlots } from "~/components/site-style";
import { cx } from "~/lib/site-style";

export async function loader({ params, request }: Route.LoaderArgs) {
  // :channelId may be a slug — resolve to the real id for booking lookups. This
  // has to happen BEFORE the session is read: a guest session belongs to one
  // property, and there is no way to ask who the guest is without saying where.
  const pid = await resolveRequestProperty(params.channelId, request);
  const session = await getGuestSession(request, pid);
  if (!session) return { authed: false as const };
  const { email } = session;
  const [allBookings, allVouchers] = await Promise.all([
    getBookingsByEmail(pid, email),
    listVouchersByEmail(pid, email).catch(() => []),
  ]);
  // A session proved by a reference alone may see that one record and nothing
  // else. Filtering here rather than at the query keeps the ONE rule in one
  // place: what the caller proved is what the caller sees.
  const bookings = allBookings.filter((b) => sessionCanSee(session, b.id));
  const vouchers = allVouchers.filter((v) => sessionCanSee(session, v.code));
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
  const base = basePath(params.channelId);
  // Resolve the property before any redirect is built from the segment — a
  // logout on a bogus segment must 404, not bounce the guest somewhere.
  const pid = await resolveRequestProperty(params.channelId, request);
  const form = await request.formData();
  if (form.get("intent") === "logout") {
    return guestLogout(request, `${base}/manage`);
  }
  // Throttle guessing: 8 lookups per 10 min per client. Fails open if no KV.
  if (!(await rateLimit(`manage:${pid}:${clientKey(request)}`, 8, 600))) {
    return { tooMany: true };
  }

  const reference = String(form.get("reference") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  if (!reference || !email) return { notFound: true };

  const booking = await findBookingByRefAndEmail(pid, reference, email);
  // Not a booking reference — maybe a voucher code (buyers of vouchers have no
  // booking). Same rule: the code must match together with the buyer's email.
  const voucher = booking
    ? null
    : await getVoucherByCode(pid, normalizeVoucherCode(reference)).catch(() => null);
  const provedId = booking
    ? booking.id
    : voucher && voucher.buyer.email.trim().toLowerCase() === email.toLowerCase()
      ? voucher.code
      : null;
  if (!provedId) return { notFound: true };

  // A reference proves knowledge of ONE record, not ownership of the mailbox —
  // anyone able to book can book under someone else's address. So count what
  // this email actually has here. If the proved record is the only one, a
  // record-scoped session reveals nothing the caller didn't already type in.
  // If there are others, they belong to whoever owns the mailbox, and only the
  // mailbox can unlock them.
  const [bookings, vouchers] = await Promise.all([
    getBookingsByEmail(pid, email),
    listVouchersByEmail(pid, email).catch(() => []),
  ]);
  const decision = guestLoginDecision({
    provedId,
    recordCount: bookings.length + vouchers.length,
  });
  if (decision.kind === "session") {
    return createGuestSession({ email, pid, only: decision.only }, `${base}/manage`);
  }

  const token = await createGuestMagicToken(email, pid);
  // Built from this request's own origin so the link works on the shared host,
  // a partner's guest host and a hotel's custom domain alike.
  const origin = new URL(request.url).origin;
  await sendGuestPortalLink(pid, email, `${origin}${base}/manage/verify?token=${encodeURIComponent(token)}`);
  return { linkSent: true };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageMeta(matches, { titleKey: "metaManage", noindex: true });
}

export default function Manage({ loaderData, actionData, params }: Route.ComponentProps) {
  const base = useBase();
  const tr = useT();
  const s = useSlots();
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
        linkSent={Boolean(actionData && "linkSent" in actionData && actionData.linkSent)}
      />
    );
  }

  const { bookings, vouchers } = loaderData;
  const statusChip: Record<string, string> = {
    active: "bg-success-soft text-success",
    redeemed: "bg-chip text-muted",
    cancelled: "bg-danger-soft text-danger",
    expired: "bg-danger-soft text-danger",
  };

  return (
    <main className="mx-auto max-w-[760px] px-7 pb-20 pt-12">
      <div className="mb-7 flex items-center justify-between gap-4">
        <h1 className="font-serif text-display-md font-medium tracking-[-0.02em]">
          {tr.t("yourBookings")}
        </h1>
        <Form method="post">
          <button
            type="submit"
            name="intent"
            value="logout"
            className="text-caption font-semibold text-muted hover:text-accent"
          >
            {tr.t("signOut")}
          </button>
        </Form>
      </div>

      {bookings.length === 0 ? (
        <div className={cx(s.card, "p-6 text-body-lg text-secondary")}>
          {tr.t("noBookingsForEmail")}
        </div>
      ) : (
        <div className={cx("overflow-hidden", s.panel)}>
          {bookings.map((b, i) => (
            <Link
              key={b.id}
              to={`${base}/manage/${b.id}`}
              className={`flex items-center justify-between gap-4 px-6 py-5 hover:bg-field-hover ${
                i > 0 ? "border-t border-divider" : ""
              }`}
            >
              <div className="min-w-0">
                <div className="font-serif text-title-sm font-semibold">
                  {fmt(b.checkin, "EEE d MMM")} — {fmt(b.checkout, "EEE d MMM yyyy")}
                </div>
                <div className="mt-1 text-caption text-muted-2">
                  {tr.t("reference")} {b.reference} · {tr.p("room", b.rooms)}
                </div>
              </div>
              <div className="flex flex-none items-center gap-4">
                <span className="font-serif text-title-sm font-semibold">
                  {formatMoney(b.total, b.currency || currency)}
                </span>
                <span className="text-caption font-semibold text-accent">{tr.t("view")} →</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {vouchers.length > 0 && (
        <>
          <h2 className="mb-4 mt-10 font-serif text-title-lg font-semibold tracking-[-0.01em]">
            {tr.t("manageVouchersTitle")}
          </h2>
          <div className={cx("overflow-hidden", s.panel)}>
            {vouchers.map((v, i) => (
              <Link
                key={v.code}
                to={`${base}/manage/voucher/${v.code}`}
                className={`flex items-center justify-between gap-4 px-6 py-5 hover:bg-field-hover ${
                  i > 0 ? "border-t border-divider" : ""
                }`}
              >
                <div className="min-w-0">
                  <div className="font-serif text-title-sm font-semibold">{v.title}</div>
                  <div className="mt-1 text-caption text-muted-2">
                    {v.code}
                    {v.recipientName ? ` · ${tr.t("manageVoucherFor", { name: v.recipientName })}` : ""}
                    {v.balance != null ? ` · ${tr.t("voucherBalance")}: ${formatMoney(v.balance, currency)}` : ""}
                  </div>
                </div>
                <div className="flex flex-none items-center gap-4">
                  <span
                    className={`rounded-full px-2.5 py-1 text-micro font-semibold ${statusChip[v.status] ?? "bg-chip text-muted"}`}
                  >
                    {tr.t(`voucherStatus_${v.status}`)}
                  </span>
                  <span className="text-caption font-semibold text-accent">{tr.t("view")} →</span>
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
  linkSent,
}: {
  params: { channelId?: string };
  submitting: boolean;
  notFound: boolean;
  tooMany: boolean;
  /** The reference was right, but this email has more than one record here, so
   *  the rest of them need the mailbox proved. */
  linkSent: boolean;
}) {
  const tr = useT();
  const s = useSlots();
  const inputCls =
    "mt-1.5 block w-full rounded-control border border-line-alt bg-surface-alt px-3.5 py-[13px] text-body-lg text-ink outline-none focus:border-accent";

  return (
    <main className="mx-auto max-w-[460px] px-7 pb-20 pt-16">
      <h1 className="mb-2 font-serif text-display-md font-medium tracking-[-0.02em]">
        {tr.t("manageTitle")}
      </h1>
      <p className="mb-7 text-body-lg leading-[1.6] text-secondary">{tr.t("manageIntro")}</p>

      {linkSent && (
        // Deliberately says nothing about what else is on the address: the
        // reference proved one record, and the count that sent us here is
        // itself information about the mailbox's owner.
        <div className="mb-6 rounded-card border border-accent/40 bg-accent-soft p-5">
          <div className="mb-1 font-serif text-title-sm font-semibold text-accent-deep">
            {tr.t("manageLinkSent")}
          </div>
          <p className="text-body text-secondary">{tr.t("manageLinkSentBody")}</p>
        </div>
      )}

      <Form
        method="post"
        className={cx("flex flex-col gap-4", s.panel, "p-6")}
      >
        <label className="block text-caption font-semibold text-secondary">
          {tr.t("manageRefOrCode")}
          <input name="reference" placeholder="ABC123 / RP-XXXX-XXXX" className={inputCls} autoComplete="off" />
        </label>
        <label className="block text-caption font-semibold text-secondary">
          {tr.t("emailAddress")}
          <input name="email" type="email" placeholder="you@email.com" className={inputCls} />
        </label>
        {tooMany ? (
          <p className="text-caption text-danger">{tr.t("manageTooMany")}</p>
        ) : (
          notFound && <p className="text-caption text-danger">{tr.t("manageNotFound")}</p>
        )}
        <button
          type="submit"
          disabled={submitting}
          className={cx("mt-1 w-full", s.btnPrimary, "py-[14px] text-lead font-semibold transition-colors disabled:opacity-60")}
        >
          {tr.t("findBooking")}
        </button>
      </Form>
    </main>
  );
}
