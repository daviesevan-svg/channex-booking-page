// Admin · Vouchers — the property's voucher catalog (STAAH-style voucher shop):
// monetary gift vouchers and bookable stay packages ("Weekend Getaway"). This
// page manages the PRODUCTS; sold vouchers get their own tab once sales exist.
import { Form, Link, redirect, useNavigation, useSearchParams } from "react-router";
import { useState } from "react";

import type { Route } from "./+types/vouchers";
import { FIELD_INPUT } from "~/components/admin-form";
import { getAdminEmail, requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, getProperty, isOwnerOrSuper } from "~/lib/properties.server";
import { getSettings } from "~/lib/overrides.server";
import { formatMoney } from "~/lib/money";
import {
  computeExpiry,
  displayStatus,
  giftBalance,
  voucherCode,
  WEEKDAY_LABELS,
  type VoucherKind,
  type VoucherProduct,
  type VoucherRecord,
} from "~/lib/vouchers";
import {
  cancelVoucher,
  claimVoucher,
  deductGift,
  deleteVoucherProduct,
  getVoucherByCode,
  getVoucherProduct,
  getVoucherProducts,
  listVouchers,
  manualRedeemPackage,
  saveVoucherProduct,
  toggleVoucherProduct,
} from "~/lib/vouchers.server";
import { sendVoucherEmails } from "~/lib/voucher-purchase.server";
import { fmtDate } from "~/lib/dates";
import { uploadVoucherImage } from "~/lib/images.server";
import { getRooms } from "~/lib/catalog.server";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse blocked ranges, one per line: "2026-12-20..2027-01-05" (single date =
 *  one-day range). Returns null on the first malformed line (with its text). */
function parseBlockedRanges(text: string): { ranges: { from: string; to: string }[] } | { bad: string } {
  const ranges: { from: string; to: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [from, to = from] = line.split("..").map((s) => s.trim());
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) return { bad: line };
    ranges.push({ from, to });
  }
  return { ranges };
}

const rangesToText = (p: VoucherProduct | null): string =>
  (p?.package?.blockedRanges ?? []).map((r) => (r.from === r.to ? r.from : `${r.from}..${r.to}`)).join("\n");

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const [products, settings, rooms] = await Promise.all([
    getVoucherProducts(propertyId),
    getSettings(propertyId),
    getRooms(propertyId),
  ]);
  const url = new URL(request.url);
  const editId = url.searchParams.get("edit");
  const tab = url.searchParams.get("tab") === "sold" ? ("sold" as const) : ("products" as const);
  const sold = tab === "sold" ? await listVouchers(propertyId).catch(() => []) : [];
  return {
    configured: true as const,
    tab,
    products,
    sold: sold.map((v) => ({
      code: v.code,
      kind: v.kind,
      title: v.product.title,
      buyerName: v.buyer.name,
      buyerEmail: v.buyer.email,
      recipientName: v.gift?.recipientName,
      status: displayStatus(v),
      balance: v.kind === "gift" ? giftBalance(v) : undefined,
      purchasedAt: v.purchasedAt,
      expiresAt: v.expiresAt,
      simulated: v.simulated ?? false,
      comp: v.comp ?? false,
    })),
    currency: settings.currency || "GBP",
    rooms: rooms.map((r) => ({ id: r.id, title: r.title })),
    editing: products.find((p) => p.id === editId) ?? null,
    creating: url.searchParams.get("new") != null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No property selected." };

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "delete") {
    await deleteVoucherProduct(propertyId, String(form.get("id")));
    return redirect("/admin/vouchers");
  }
  if (intent === "toggle") {
    await toggleVoucherProduct(propertyId, String(form.get("id")));
    return redirect("/admin/vouchers");
  }

  // ---- sold-voucher management ----
  const code = String(form.get("code") ?? "");
  const soldTab = "/admin/vouchers?tab=sold";
  const ownerGate = async () =>
    (await isOwnerOrSuper(request, propertyId)) ? null : { error: "Only an owner or manager can do that." };

  if (intent === "voucherResend") {
    const v = await getVoucherByCode(propertyId, code);
    if (!v) return { error: "Voucher not found." };
    const prop = await getProperty(propertyId);
    await sendVoucherEmails(propertyId, v, new URL(request.url).origin, prop?.slug || propertyId);
    return redirect(soldTab);
  }
  if (intent === "voucherCancel") {
    const gate = await ownerGate();
    if (gate) return gate;
    if (!(await cancelVoucher(propertyId, code))) return { error: "Only an active voucher can be cancelled." };
    return redirect(soldTab);
  }
  if (intent === "voucherRedeemManual") {
    const gate = await ownerGate();
    if (gate) return gate;
    const by = (await getAdminEmail(request)) ?? "admin";
    if (!(await manualRedeemPackage(propertyId, code, by))) return { error: "Only an active package voucher can be marked redeemed." };
    return redirect(soldTab);
  }
  if (intent === "voucherDeduct") {
    const gate = await ownerGate();
    if (gate) return gate;
    const amount = Math.round(Number(String(form.get("amount") ?? "")) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) return { error: "Enter the amount to deduct." };
    const by = (await getAdminEmail(request)) ?? "admin";
    if (!(await deductGift(propertyId, code, amount, by))) {
      return { error: "Couldn't deduct — check the voucher is active and has enough balance." };
    }
    return redirect(soldTab);
  }
  if (intent === "voucherComp") {
    const gate = await ownerGate();
    if (gate) return gate;
    const product = await getVoucherProduct(propertyId, String(form.get("productId")));
    if (!product) return { error: "Pick a voucher to issue." };
    const recipientName = String(form.get("recipientName") ?? "").trim();
    const recipientEmail = String(form.get("recipientEmail") ?? "").trim();
    const message = String(form.get("message") ?? "").trim();
    if (!recipientName) return { error: "Enter the recipient's name." };
    if (recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) return { error: "The recipient's email doesn't look valid." };
    const by = (await getAdminEmail(request)) ?? "the hotel";
    let roomTitles: string[] | undefined;
    if (product.package) {
      const rooms = await getRooms(propertyId).catch(() => []);
      roomTitles = product.package.roomIds
        .map((id) => rooms.find((r) => r.id === id)?.title)
        .filter((t): t is string => Boolean(t));
    }
    const now = new Date().toISOString();
    const record: VoucherRecord = {
      id: crypto.randomUUID(),
      code: voucherCode(),
      kind: product.kind,
      productId: product.id,
      product: {
        title: product.title,
        description: product.description,
        image: product.image,
        price: product.price,
        value: product.kind === "gift" ? (product.value ?? product.price) : undefined,
        terms: product.terms,
        package: product.package,
        roomTitles,
      },
      buyer: { name: "Compliments of the hotel", email: by },
      gift: { recipientName, recipientEmail: recipientEmail || undefined, message: message || undefined },
      purchasedAt: now,
      expiresAt: computeExpiry(now, product.expiresMonths),
      status: "active",
      balance: product.kind === "gift" ? (product.value ?? product.price) : undefined,
      redemptions: [],
      comp: true,
    };
    await claimVoucher(propertyId, record);
    const prop = await getProperty(propertyId);
    await sendVoucherEmails(propertyId, record, new URL(request.url).origin, prop?.slug || propertyId);
    return redirect(soldTab);
  }

  // intent === "save"
  const id = String(form.get("id") || "").trim();
  const kind: VoucherKind = form.get("kind") === "package" ? "package" : "gift";
  const title = String(form.get("title") ?? "").trim();
  const description = String(form.get("description") ?? "").trim() || undefined;
  const price = Math.round(Number(String(form.get("price") ?? "").trim()) * 100) / 100;
  const valueRaw = String(form.get("value") ?? "").trim();
  const expiresMonths = Math.round(Number(String(form.get("expiresMonths") ?? "12").trim()));
  const capRaw = String(form.get("cap") ?? "").trim();
  const terms = String(form.get("terms") ?? "").trim() || undefined;
  const active = form.get("active") != null;

  if (!title) return { error: "Enter a name for the voucher." };
  if (!Number.isFinite(price) || price <= 0) return { error: "Set a sale price." };
  if (!Number.isFinite(expiresMonths) || expiresMonths < 1 || expiresMonths > 60) {
    return { error: "Validity must be between 1 and 60 months." };
  }
  const cap = capRaw === "" ? undefined : Math.round(Number(capRaw));
  if (cap !== undefined && (!Number.isFinite(cap) || cap < 1)) return { error: "The sale limit must be a positive number." };

  let value: number | undefined;
  let pkg: VoucherProduct["package"];
  if (kind === "gift") {
    value = valueRaw === "" ? price : Math.round(Number(valueRaw) * 100) / 100;
    if (!Number.isFinite(value) || value <= 0) return { error: "The gift value must be a positive amount." };
  } else {
    const nights = Math.round(Number(String(form.get("nights") ?? "").trim()));
    const adults = Math.round(Number(String(form.get("adults") ?? "2").trim()));
    const childrenRaw = String(form.get("children") ?? "").trim();
    const children = childrenRaw === "" ? undefined : Math.round(Number(childrenRaw));
    const roomIds = form.getAll("roomIds").map(String).filter(Boolean);
    const windowFrom = String(form.get("windowFrom") ?? "").trim();
    const windowTo = String(form.get("windowTo") ?? "").trim();
    const checkinDays = form.getAll("checkinDays").map((d) => Number(d)).filter((d) => d >= 0 && d <= 6);

    if (!Number.isFinite(nights) || nights < 1 || nights > 30) return { error: "Set the number of nights (1–30)." };
    if (!Number.isFinite(adults) || adults < 1) return { error: "Set how many adults the package includes." };
    if (children !== undefined && (!Number.isFinite(children) || children < 0)) return { error: "Children must be 0 or more." };
    if (roomIds.length === 0) return { error: "Tick at least one room type the package can be booked into." };
    if (windowFrom && !ISO_DATE.test(windowFrom)) return { error: "The stay window 'from' date is invalid." };
    if (windowTo && !ISO_DATE.test(windowTo)) return { error: "The stay window 'to' date is invalid." };
    if (windowFrom && windowTo && windowFrom > windowTo) return { error: "The stay window ends before it starts." };
    const parsed = parseBlockedRanges(String(form.get("blockedRanges") ?? ""));
    if ("bad" in parsed) return { error: `Can't read blocked date line: "${parsed.bad}" — use YYYY-MM-DD..YYYY-MM-DD.` };

    pkg = {
      nights,
      adults,
      children,
      roomIds,
      window: windowFrom || windowTo ? { from: windowFrom || undefined, to: windowTo || undefined } : undefined,
      blockedRanges: parsed.ranges,
      checkinDays,
    };
  }

  const existing = await getVoucherProducts(propertyId);
  const prev = existing.find((p) => p.id === id);
  const finalId = id || crypto.randomUUID();

  let image = form.get("removeImage") != null ? undefined : prev?.image;
  const upload = form.getAll("image").find((f): f is File => f instanceof File && f.size > 0);
  if (upload) {
    try {
      image = await uploadVoucherImage(propertyId, finalId, upload);
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Image upload failed." };
    }
  }

  const product: VoucherProduct = {
    id: finalId,
    kind,
    active,
    position: prev?.position ?? existing.length,
    createdAt: prev?.createdAt ?? new Date().toISOString(),
    title,
    description,
    image,
    price,
    value,
    expiresMonths,
    cap,
    terms,
    package: pkg,
  };
  await saveVoucherProduct(propertyId, product);
  return redirect("/admin/vouchers");
}

export function meta() {
  return [{ title: "Admin · Vouchers" }];
}

function summary(p: VoucherProduct, currency: string): string {
  const bits = [formatMoney(p.price, currency)];
  if (p.kind === "gift") bits.push(`${formatMoney(p.value ?? p.price, currency)} value`);
  else if (p.package) {
    bits.push(`${p.package.nights} night${p.package.nights === 1 ? "" : "s"} · ${p.package.adults} adult${p.package.adults === 1 ? "" : "s"}${p.package.children ? ` + ${p.package.children} child${p.package.children === 1 ? "" : "ren"}` : ""}`);
    if (p.package.checkinDays.length) bits.push(`check-in ${p.package.checkinDays.map((d) => WEEKDAY_LABELS[d]).join("/")}`);
  }
  bits.push(`valid ${p.expiresMonths}mo`);
  if (p.cap) bits.push(`max ${p.cap}`);
  return bits.join(" · ");
}

export default function AdminVouchers({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const [searchParams] = useSearchParams();

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Vouchers</h1>
        <p className="text-[15px] text-secondary">Add a property first to sell vouchers.</p>
      </div>
    );
  }

  const { products, sold, tab, currency, rooms, editing, creating } = loaderData;
  const checkbox = "h-4 w-4 rounded border-line-alt text-accent focus:ring-accent";
  const showForm = tab === "products" && (!!editing || creating || products.length === 0);
  // The kind selector swaps the form's second half; live client state, seeded
  // from the record being edited (or ?kind= for a fresh form).
  const [kind, setKind] = useState<VoucherKind>(editing?.kind ?? (searchParams.get("kind") === "package" ? "package" : "gift"));

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">Vouchers</h1>
      <p className="mb-6 text-[14px] text-muted">
        Sell vouchers from your booking page — a new revenue channel with cash up front.{" "}
        <strong>Gift vouchers</strong> carry a value guests spend on a booking.{" "}
        <strong>Stay packages</strong> (e.g. “Weekend Getaway — 2 nights for 2”) are bought now and{" "}
        <strong>booked online later</strong> under your rules: which rooms, which dates, which
        check-in days.
      </p>

      <div className="mb-6 flex gap-1 rounded-[10px] border border-line bg-surface p-1" style={{ width: "fit-content" }}>
        {([["products", "For sale"], ["sold", `Sold (${tab === "sold" ? sold.length : "…"})`]] as const).map(([t, label]) => (
          <Link
            key={t}
            to={t === "products" ? "/admin/vouchers" : "/admin/vouchers?tab=sold"}
            className={`rounded-[8px] px-4 py-2 text-[13.5px] font-semibold ${tab === t ? "bg-accent text-white" : "text-muted hover:text-ink"}`}
          >
            {label}
          </Link>
        ))}
      </div>

      {tab === "sold" ? (
        <>
        {/* Issue a free voucher (loyalty gesture, competition prize, service recovery). */}
        {products.length > 0 && (
          <details className="mb-5 rounded-[14px] border border-line bg-surface p-5">
            <summary className="cursor-pointer text-[14px] font-semibold text-secondary hover:text-accent">
              Issue a complimentary voucher
            </summary>
            <Form method="post" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <input type="hidden" name="intent" value="voucherComp" />
              <label className="block text-[13px] font-semibold text-secondary">
                Voucher
                <select name="productId" className={FIELD_INPUT}>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title} ({p.kind === "gift" ? "gift" : "package"})
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-[13px] font-semibold text-secondary">
                Recipient's name
                <input name="recipientName" className={FIELD_INPUT} />
              </label>
              <label className="block text-[13px] font-semibold text-secondary">
                Recipient's email <span className="font-normal text-faint">(optional — we'll email them the voucher)</span>
                <input name="recipientEmail" type="email" className={FIELD_INPUT} />
              </label>
              <label className="block text-[13px] font-semibold text-secondary">
                Message <span className="font-normal text-faint">(optional)</span>
                <input name="message" className={FIELD_INPUT} />
              </label>
              <div className="sm:col-span-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
                >
                  Issue voucher (free)
                </button>
              </div>
            </Form>
          </details>
        )}
        {actionData?.error && (
          <p className="mb-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-700">
            {actionData.error}
          </p>
        )}
        {sold.length === 0 ? (
          <div className="rounded-[14px] border border-line bg-surface p-6 text-[14px] text-secondary">
            No vouchers sold yet. When guests buy from your voucher shop they appear here.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-[14px] border border-line bg-surface">
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="border-b border-line text-left text-[11.5px] uppercase tracking-wide text-muted-2">
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Voucher</th>
                  <th className="px-4 py-3">Buyer</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Balance</th>
                  <th className="px-4 py-3">Bought</th>
                  <th className="px-4 py-3">Expires</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sold.map((v) => (
                  <tr key={v.code} className="border-b border-divider last:border-0">
                    <td className="px-4 py-3 font-mono text-[12.5px] font-semibold text-accent-deep">{v.code}</td>
                    <td className="px-4 py-3">
                      {v.title}
                      {v.simulated && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-semibold text-amber-800">test</span>}
                      {v.comp && <span className="ml-2 rounded-full bg-chip px-2 py-0.5 text-[10.5px] font-semibold text-muted">comp</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div>{v.buyerName}{v.recipientName ? ` → ${v.recipientName}` : ""}</div>
                      <div className="text-[12px] text-muted-2">{v.buyerEmail}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${v.status === "active" ? "bg-[#e8f0e6] text-[#3f7a52]" : v.status === "redeemed" ? "bg-chip text-muted" : "bg-[#fbe9e7] text-[#c0392b]"}`}>
                        {v.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">{v.balance != null ? formatMoney(v.balance, currency) : "—"}</td>
                    <td className="px-4 py-3 text-muted">{fmtDate(v.purchasedAt, "d MMM yyyy")}</td>
                    <td className="px-4 py-3 text-muted">{fmtDate(v.expiresAt, "d MMM yyyy")}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2.5 text-[12.5px] font-semibold">
                        <Form method="post">
                          <input type="hidden" name="intent" value="voucherResend" />
                          <input type="hidden" name="code" value={v.code} />
                          <button type="submit" disabled={saving} className="text-muted hover:text-accent">Resend</button>
                        </Form>
                        {v.status === "active" && v.kind === "package" && (
                          <Form method="post" onSubmit={(e) => { if (!confirm("Mark this package voucher as redeemed (booked by phone/at the desk)?")) e.preventDefault(); }}>
                            <input type="hidden" name="intent" value="voucherRedeemManual" />
                            <input type="hidden" name="code" value={v.code} />
                            <button type="submit" disabled={saving} className="text-muted hover:text-accent">Mark redeemed</button>
                          </Form>
                        )}
                        {v.status === "active" && v.kind === "gift" && (
                          <Form method="post" className="flex items-center gap-1.5">
                            <input type="hidden" name="intent" value="voucherDeduct" />
                            <input type="hidden" name="code" value={v.code} />
                            <input
                              name="amount"
                              type="number"
                              min={0.01}
                              step="0.01"
                              placeholder="0.00"
                              className="w-[76px] rounded-[8px] border border-line-alt bg-surface px-2 py-1 text-[12.5px] font-normal outline-none focus:border-accent"
                            />
                            <button type="submit" disabled={saving} className="text-muted hover:text-accent">Deduct</button>
                          </Form>
                        )}
                        {v.status === "active" && (
                          <Form method="post" onSubmit={(e) => { if (!confirm("Cancel this voucher? It can no longer be used. Refund any payment separately in Stripe.")) e.preventDefault(); }}>
                            <input type="hidden" name="intent" value="voucherCancel" />
                            <input type="hidden" name="code" value={v.code} />
                            <button type="submit" disabled={saving} className="text-[#c0392b] hover:underline">Cancel</button>
                          </Form>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </>
      ) : (
      <>
      {!showForm && (
        <div className="mb-7 flex gap-3">
          <Link
            to="/admin/vouchers?new=1&kind=gift"
            className="inline-block rounded-[10px] bg-accent px-5 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep"
          >
            + Gift voucher
          </Link>
          <Link
            to="/admin/vouchers?new=1&kind=package"
            className="inline-block rounded-[10px] border border-accent px-5 py-3 text-[15px] font-semibold text-accent hover:bg-accent-soft"
          >
            + Stay package
          </Link>
        </div>
      )}

      {showForm && (
        <Form
          method="post"
          encType="multipart/form-data"
          key={editing?.id ?? "new"}
          className="mb-7 flex flex-col gap-4 rounded-[14px] border border-line bg-surface p-6"
        >
          <input type="hidden" name="intent" value="save" />
          <input type="hidden" name="id" defaultValue={editing?.id ?? ""} />

          <div className="flex items-center justify-between">
            <h2 className="font-serif text-[18px] font-semibold">
              {editing ? "Edit voucher" : "New voucher"}
            </h2>
            {(editing || creating) && (
              <Link to="/admin/vouchers" className="text-[13px] font-semibold text-muted hover:text-accent">
                Cancel
              </Link>
            )}
          </div>

          <label className="block text-[13px] font-semibold text-secondary">
            Type
            <select
              name="kind"
              value={kind}
              onChange={(e) => setKind(e.target.value === "package" ? "package" : "gift")}
              disabled={!!editing}
              className={FIELD_INPUT}
            >
              <option value="gift">Gift voucher — a value to spend on any booking</option>
              <option value="package">Stay package — a specific stay, booked online later</option>
            </select>
            {editing ? (
              <input type="hidden" name="kind" value={editing.kind} />
            ) : null}
            {editing && (
              <span className="mt-1 block text-[11px] font-normal text-faint">
                The type can't change after creation — sold vouchers snapshot it.
              </span>
            )}
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-[13px] font-semibold text-secondary">
              Name
              <input
                name="title"
                defaultValue={editing?.title ?? ""}
                placeholder={kind === "package" ? "Weekend Getaway" : "£100 Gift Voucher"}
                className={FIELD_INPUT}
              />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Sale price ({currency})
              <input
                name="price"
                type="number"
                min={0}
                step="0.01"
                defaultValue={editing ? String(editing.price) : ""}
                placeholder={kind === "package" ? "249" : "100"}
                className={FIELD_INPUT}
              />
            </label>
          </div>

          {kind === "gift" && (
            <label className="block text-[13px] font-semibold text-secondary">
              Gift value ({currency}){" "}
              <span className="font-normal text-faint">(what the buyer gets to spend — leave blank to match the price; set higher for an incentive, e.g. pay 90 get 100)</span>
              <input
                name="value"
                type="number"
                min={0}
                step="0.01"
                defaultValue={editing?.value != null ? String(editing.value) : ""}
                placeholder="same as price"
                className={FIELD_INPUT}
              />
            </label>
          )}

          <label className="block text-[13px] font-semibold text-secondary">
            Description <span className="font-normal text-faint">(shown in the shop)</span>
            <textarea
              name="description"
              rows={2}
              defaultValue={editing?.description ?? ""}
              placeholder={
                kind === "package"
                  ? "Two nights for two in a Garden Suite, any off-season weekend. Breakfast included."
                  : "The perfect gift — they choose the dates, you cover the stay."
              }
              className={`${FIELD_INPUT} resize-y`}
            />
          </label>

          <div className="text-[13px] font-semibold text-secondary">
            Photo <span className="font-normal text-faint">(optional — the voucher's card in the shop)</span>
            <div className="mt-1.5 flex items-start gap-4">
              {editing?.image && (
                <div className="flex flex-none flex-col items-center gap-1.5">
                  <img src={editing.image} alt="" className="h-[72px] w-[104px] flex-none rounded-[10px] border border-line object-cover" />
                  <label className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
                    <input type="checkbox" name="removeImage" className={checkbox} />
                    Remove
                  </label>
                </div>
              )}
              <input
                type="file"
                name="image"
                accept="image/*"
                className="block w-full text-[13px] font-normal text-muted file:mr-3 file:rounded-[8px] file:border-0 file:bg-accent-soft file:px-4 file:py-2 file:text-[13px] file:font-semibold file:text-accent-deep hover:file:bg-accent-soft-strong"
              />
            </div>
          </div>

          {kind === "package" && (
            <fieldset className="flex flex-col gap-4 rounded-[12px] border border-line bg-surface-alt/40 p-4">
              <legend className="px-1 text-[13px] font-semibold text-secondary">The stay</legend>
              <div className="grid grid-cols-3 gap-4">
                <label className="block text-[13px] font-semibold text-secondary">
                  Nights
                  <input name="nights" type="number" min={1} max={30} defaultValue={editing?.package?.nights ?? 2} className={FIELD_INPUT} />
                </label>
                <label className="block text-[13px] font-semibold text-secondary">
                  Adults
                  <input name="adults" type="number" min={1} defaultValue={editing?.package?.adults ?? 2} className={FIELD_INPUT} />
                </label>
                <label className="block text-[13px] font-semibold text-secondary">
                  Children
                  <input name="children" type="number" min={0} defaultValue={editing?.package?.children ?? ""} placeholder="0" className={FIELD_INPUT} />
                </label>
              </div>

              <div>
                <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-2">Bookable room types</div>
                <div className="flex flex-col gap-1.5">
                  {rooms.map((r) => (
                    <label key={r.id} className="flex items-center gap-2 text-[13.5px] font-medium text-secondary">
                      <input
                        type="checkbox"
                        name="roomIds"
                        value={r.id}
                        defaultChecked={editing?.package?.roomIds.includes(r.id) ?? false}
                        className={checkbox}
                      />
                      {r.title}
                    </label>
                  ))}
                  {rooms.length === 0 && (
                    <span className="text-[12.5px] text-muted">No room types yet — add rooms first.</span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <label className="block text-[13px] font-semibold text-secondary">
                  Stay window from <span className="font-normal text-faint">(optional)</span>
                  <input name="windowFrom" type="date" defaultValue={editing?.package?.window?.from ?? ""} className={FIELD_INPUT} />
                </label>
                <label className="block text-[13px] font-semibold text-secondary">
                  Stay window until <span className="font-normal text-faint">(optional)</span>
                  <input name="windowTo" type="date" defaultValue={editing?.package?.window?.to ?? ""} className={FIELD_INPUT} />
                </label>
              </div>

              <div>
                <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-2">
                  Check-in allowed on
                </div>
                <div className="flex flex-wrap gap-3">
                  {WEEKDAY_LABELS.map((label, d) => (
                    <label key={d} className="flex items-center gap-1.5 text-[13.5px] font-medium text-secondary">
                      <input
                        type="checkbox"
                        name="checkinDays"
                        value={d}
                        defaultChecked={editing?.package?.checkinDays.includes(d) ?? false}
                        className={checkbox}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <span className="mt-1 block text-[11px] font-normal text-faint">
                  Leave all unticked to allow any day. For a weekend package tick Fri + Sat.
                </span>
              </div>

              <label className="block text-[13px] font-semibold text-secondary">
                Blocked dates <span className="font-normal text-faint">(one range per line — e.g. peak season)</span>
                <textarea
                  name="blockedRanges"
                  rows={2}
                  defaultValue={rangesToText(editing)}
                  placeholder={"2026-12-20..2027-01-05\n2027-04-02..2027-04-05"}
                  className={`${FIELD_INPUT} resize-y font-mono text-[13px]`}
                />
                <span className="mt-1 block text-[11px] font-normal text-faint">
                  Format: <code>YYYY-MM-DD..YYYY-MM-DD</code> (a single date blocks just that check-in day).
                </span>
              </label>
            </fieldset>
          )}

          <div className="grid grid-cols-2 gap-4">
            <label className="block text-[13px] font-semibold text-secondary">
              Valid for (months after purchase)
              <input name="expiresMonths" type="number" min={1} max={60} defaultValue={editing?.expiresMonths ?? 12} className={FIELD_INPUT} />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Sale limit <span className="font-normal text-faint">(optional)</span>
              <input name="cap" type="number" min={1} defaultValue={editing?.cap ?? ""} placeholder="unlimited" className={FIELD_INPUT} />
            </label>
          </div>

          <label className="block text-[13px] font-semibold text-secondary">
            Terms <span className="font-normal text-faint">(optional — shown on the voucher and at purchase)</span>
            <textarea
              name="terms"
              rows={2}
              defaultValue={editing?.terms ?? ""}
              placeholder="Subject to availability. Non-transferable. No cash value."
              className={`${FIELD_INPUT} resize-y`}
            />
          </label>

          <label className="flex items-center gap-2.5 text-[14px] font-semibold">
            <input type="checkbox" name="active" defaultChecked={editing ? editing.active : true} className={checkbox} />
            On sale (shown in the shop)
          </label>

          {actionData?.error && <p className="text-[13px] text-red-600">{actionData.error}</p>}
          <div>
            <button
              type="submit"
              disabled={saving}
              className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
            >
              {saving ? "Saving…" : editing ? "Save voucher" : "Add voucher"}
            </button>
          </div>
        </Form>
      )}

      {products.length === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-6 text-[14px] text-secondary">
          No vouchers yet. Create your first one above.
        </div>
      ) : (
        <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
          {products.map((p, i) => (
            <div
              key={p.id}
              className={`flex items-center justify-between gap-4 px-5 py-4 ${i > 0 ? "border-t border-divider" : ""}`}
            >
              <div className="flex min-w-0 items-center gap-3.5">
                {p.image ? (
                  <img src={p.image} alt="" className="h-11 w-16 flex-none rounded-[8px] border border-line object-cover" />
                ) : (
                  <div className="h-11 w-16 flex-none rounded-[8px] border border-line" style={{ background: "repeating-linear-gradient(135deg,#efe7da,#efe7da 8px,#e7ddcc 8px,#e7ddcc 16px)" }} />
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <span className="font-semibold">{p.title}</span>
                    <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-muted">
                      {p.kind === "gift" ? "Gift voucher" : "Stay package"}
                    </span>
                    {p.active ? (
                      <span className="rounded-full bg-[#e8f0e6] px-2 py-0.5 text-[11px] font-semibold text-[#3f7a52]">On sale</span>
                    ) : (
                      <span className="rounded-full bg-surface-alt px-2 py-0.5 text-[11px] font-semibold text-muted-2">Hidden</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[12.5px] text-muted-2">{summary(p, currency)}</div>
                </div>
              </div>
              <div className="flex flex-none items-center gap-3">
                <Form method="post">
                  <input type="hidden" name="id" value={p.id} />
                  <button type="submit" name="intent" value="toggle" className="text-[13px] font-semibold text-muted hover:text-accent">
                    {p.active ? "Hide" : "Show"}
                  </button>
                </Form>
                <Link to={`/admin/vouchers?edit=${p.id}`} className="text-[13px] font-semibold text-accent hover:underline">
                  Edit
                </Link>
                <Form method="post" onSubmit={(ev) => { if (!confirm(`Delete "${p.title}"? Already-sold vouchers keep working.`)) ev.preventDefault(); }}>
                  <input type="hidden" name="id" value={p.id} />
                  <button type="submit" name="intent" value="delete" className="text-[13px] font-semibold text-[#c0392b] hover:underline">
                    Delete
                  </button>
                </Form>
              </div>
            </div>
          ))}
        </div>
      )}
      </>
      )}
    </div>
  );
}
