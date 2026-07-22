// Admin · Vouchers — the property's voucher catalog (STAAH-style voucher shop):
// monetary gift vouchers and bookable stay packages ("Weekend Getaway"). This
// page manages the PRODUCTS; sold vouchers get their own tab once sales exist.
import { Form, Link, redirect, useNavigation, useSearchParams } from "react-router";
import { useEffect, useState } from "react";

import type { Route } from "./+types/vouchers";
import { FIELD_INPUT, FilePicker } from "~/components/admin-form";
import { BlockedRangesEditor } from "~/components/blocked-ranges";
import { useAdminDateLocale, useAdminT, type AdminT } from "~/lib/admin-i18n";
import { getAdminEmail, requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, getProperty, isOwnerOrSuper } from "~/lib/properties.server";
import { getOverrides, getSettings, patchSettings } from "~/lib/overrides.server";
import { accentHex } from "~/lib/email-render.server";
import { formatMoney } from "~/lib/money";
import {
  computeExpiry,
  DEFAULT_COOLING_OFF_DAYS,
  displayStatus,
  giftBalance,
  parseBlockedRanges,
  voucherCode,
  WEEKDAY_LABELS,
  type VoucherKind,
  type VoucherProduct,
  type VoucherRecord,
} from "~/lib/vouchers";
import {
  claimVoucher,
  deleteVoucherProduct,
  getVoucherProduct,
  getVoucherProducts,
  listVouchers,
  saveVoucherProduct,
  toggleVoucherProduct,
} from "~/lib/vouchers.server";
import { sendVoucherEmails } from "~/lib/voucher-purchase.server";
import { fmtDate } from "~/lib/dates";
import { uploadVoucherImage } from "~/lib/images.server";
import { getRooms } from "~/lib/catalog.server";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Starter terms for a NEW voucher (edit or replace freely). Kept honest:
 *  they must not contradict the built-in cooling-off refund, so "no cash
 *  value" rather than "non-refundable". */
const DEFAULT_TERMS: Record<VoucherKind, string> = {
  gift: "Redeemable against stays booked on our website. Any remaining balance stays on the voucher for a future stay. No cash value. Valid until the expiry date shown on the voucher.",
  package:
    "Subject to availability within the package's allowed dates. Covers the stay described — extras and incidentals are payable at the hotel. No cash value. Valid until the expiry date shown on the voucher.",
  experience:
    "Valid for one visit. Please contact us ahead to arrange a date or time. No cash value and non-transferable once redeemed. Valid until the expiry date shown on the voucher.",
};


/** The ready-to-paste AI image brief, built from the live form values —
 *  a DESIGNED card (text + flat illustration, YouTube-thumbnail readable),
 *  not a photo: photorealistic prompts just invent someone else's hotel.
 *  Wording tested by Evan against real image models before shipping.
 *  Returns the missing key fields instead when the offer isn't described
 *  yet — the brief is only as good as the details it carries. */
function buildImageBrief(
  form: HTMLFormElement,
  kind: VoucherKind,
  hotelName: string,
  currency: string,
  accent: string,
  bg: string,
): { brief: string } | { missing: string[] } {
  const val = (n: string) => {
    const el = form.elements.namedItem(n);
    return el && "value" in el ? String((el as { value: string }).value).trim() : "";
  };
  const title = val("title");
  const price = val("price");
  const description = val("description");
  const missing = [
    !title && "Name",
    !price && "Sale price",
    !description && "Description",
    kind === "package" && !val("nights") && "Nights",
  ].filter((x): x is string => Boolean(x));
  if (missing.length) return { missing };

  const kindLabel = kind === "gift" ? "gift voucher" : kind === "package" ? "a bookable stay package" : "an experience voucher";

  let subline: string;
  if (kind === "package") {
    const nights = Number(val("nights"));
    const guests = Number(val("adults") || "2") + Number(val("children") || "0");
    subline = `${nights} night${nights === 1 ? "" : "s"} · ${guests} guest${guests === 1 ? "" : "s"}`;
  } else if (kind === "experience") {
    const g = Number(val("guests") || "0");
    subline = g > 0 ? `For ${g} guest${g === 1 ? "" : "s"}` : hotelName;
  } else {
    subline = hotelName;
  }

  const illustration =
    kind === "gift"
      ? "a gift box with ribbon and a small nod to the hotel — a room key, a bed, an awning"
      : kind === "package"
        ? "a cosy suite or the getaway's setting — a bed, a fireplace, a coastline at dusk"
        : "the experience itself, matching the description — e.g. a candlelit table for two, spa stones and towels, a sun lounger by a pool";

  const brief = `Create ONE promotional graphic for a hotel voucher sold online — a designed card,
not a photograph. Think YouTube thumbnail or premium gift card: the offer should
be understood at a glance, without reading anything else on the page.

THE OFFER
- Hotel: ${hotelName}
- Voucher: "${title}" (${kindLabel})
- What it is: ${description}
- Price: ${price} ${currency}

TEXT ON THE IMAGE — exactly this and nothing else:
- Headline (large): ${title}
- Subline (small): ${subline}
Spell the text exactly as written. Elegant serif for the headline. No other
words, numbers, logos or watermarks anywhere.

STYLE
- Modern flat illustration with a warm, premium feel — NOT a photo, NOT
  photorealistic, no 3D render.
- Palette: ${accent} on ${bg}, plus 2–3 muted supporting tones.
- Illustrate the offer around the text: ${illustration}. Simple shapes, no faces.
- Bold and readable at thumbnail size; generous margins — keep all text well
  clear of the edges.

FORMAT
- Landscape 3:2, at least 1600 × 1067 px. JPEG or PNG, under 8 MB.

When you have the image, upload it in the voucher editor's Photo field.`;
  return { brief };
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const [products, settings, rooms, ov] = await Promise.all([
    getVoucherProducts(propertyId),
    getSettings(propertyId),
    getRooms(propertyId),
    getOverrides(propertyId),
  ]);
  const url = new URL(request.url);
  const editId = url.searchParams.get("edit");
  const tab = url.searchParams.get("tab") === "sold" ? ("sold" as const) : ("products" as const);
  const compIssued = url.searchParams.get("comp");
  const sold = tab === "sold" ? await listVouchers(propertyId).catch(() => []) : [];
  return {
    configured: true as const,
    tab,
    compIssued,
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
    hotelName: ov.hotelName || "the hotel",
    brandAccent: accentHex(settings),
    brandBg: settings.customBg || "#F6F1E7",
    coolingOffDays: settings.voucherCoolingOffDays ?? DEFAULT_COOLING_OFF_DAYS,
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

  if (intent === "selfService") {
    const raw = String(form.get("coolingOffDays") ?? "").trim();
    const days = raw === "" ? DEFAULT_COOLING_OFF_DAYS : Math.round(Number(raw));
    if (!Number.isFinite(days) || days < 0 || days > 365) {
      return { error: "The cooling-off window must be between 0 and 365 days." };
    }
    await patchSettings(propertyId, { voucherCoolingOffDays: days });
    return redirect("/admin/vouchers");
  }
  if (intent === "delete") {
    await deleteVoucherProduct(propertyId, String(form.get("id")));
    return redirect("/admin/vouchers");
  }
  if (intent === "toggle") {
    await toggleVoucherProduct(propertyId, String(form.get("id")));
    return redirect("/admin/vouchers");
  }

  // ---- sold-voucher management (per-voucher actions live on /admin/vouchers/:code) ----
  const soldTab = "/admin/vouchers?tab=sold";
  const ownerGate = async () =>
    (await isOwnerOrSuper(request, propertyId)) ? null : { error: "Only an owner or manager can do that." };

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
        guests: product.guests,
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
    return redirect(`${soldTab}&comp=${record.code}`);
  }

  // intent === "save"
  const id = String(form.get("id") || "").trim();
  const rawKind = form.get("kind");
  const kind: VoucherKind = rawKind === "package" ? "package" : rawKind === "experience" ? "experience" : "gift";
  const title = String(form.get("title") ?? "").trim();
  const description = String(form.get("description") ?? "").trim() || undefined;
  const price = Math.round(Number(String(form.get("price") ?? "").trim()) * 100) / 100;
  const valueRaw = String(form.get("value") ?? "").trim();
  const expiresMonths = Math.round(Number(String(form.get("expiresMonths") ?? "12").trim()));
  const capRaw = String(form.get("cap") ?? "").trim();
  const terms = String(form.get("terms") ?? "").trim() || undefined;
  const included = String(form.get("included") ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const active = form.get("active") != null;

  if (!title) return { error: "Enter a name for the voucher." };
  if (!Number.isFinite(price) || price <= 0) return { error: "Set a sale price." };
  if (!Number.isFinite(expiresMonths) || expiresMonths < 1 || expiresMonths > 60) {
    return { error: "Validity must be between 1 and 60 months." };
  }
  const cap = capRaw === "" ? undefined : Math.round(Number(capRaw));
  if (cap !== undefined && (!Number.isFinite(cap) || cap < 1)) return { error: "The sale limit must be a positive number." };

  let value: number | undefined;
  let guests: number | undefined;
  let pkg: VoucherProduct["package"];
  if (kind === "experience") {
    const guestsRaw = String(form.get("guests") ?? "").trim();
    guests = guestsRaw === "" ? undefined : Math.round(Number(guestsRaw));
    if (guests !== undefined && (!Number.isFinite(guests) || guests < 1 || guests > 50)) {
      return { error: "Guests must be between 1 and 50 (or left blank)." };
    }
  } else if (kind === "gift") {
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
    included: included.length ? included : undefined,
    guests,
    package: pkg,
  };
  await saveVoucherProduct(propertyId, product);
  return redirect("/admin/vouchers");
}

export function meta() {
  return [{ title: "Admin · Vouchers" }];
}

function summary(p: VoucherProduct, currency: string, t: AdminT): string {
  const bits = [formatMoney(p.price, currency)];
  if (p.kind === "gift") bits.push(t("voSumValue", { amount: formatMoney(p.value ?? p.price, currency) }));
  else if (p.kind === "experience") bits.push(p.guests ? t(p.guests === 1 ? "voSumGuests_one" : "voSumGuests_other", { n: p.guests }) : t("voSumInPerson"));
  else if (p.package) {
    const nights = t(p.package.nights === 1 ? "voSumNights_one" : "voSumNights_other", { n: p.package.nights });
    const adults = t(p.package.adults === 1 ? "voSumAdults_one" : "voSumAdults_other", { n: p.package.adults });
    const children = p.package.children
      ? ` ${t(p.package.children === 1 ? "voSumChildren_one" : "voSumChildren_other", { n: p.package.children })}`
      : "";
    bits.push(`${nights} · ${adults}${children}`);
    if (p.package.checkinDays.length) bits.push(t("voSumCheckin", { days: p.package.checkinDays.map((d) => t(`voWd${d}`)).join("/") }));
  }
  bits.push(t("voSumValid", { n: p.expiresMonths }));
  if (p.cap) bits.push(t("voSumMax", { n: p.cap }));
  return bits.join(" · ");
}

export default function AdminVouchers({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const [searchParams] = useSearchParams();
  const t = useAdminT();
  const dl = useAdminDateLocale();

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{t("voTitle")}</h1>
        <p className="text-[15px] text-secondary">{t("voAddPropertyFirst")}</p>
      </div>
    );
  }

  const { products, sold, tab, compIssued, currency, hotelName, brandAccent, brandBg, coolingOffDays, rooms, editing, creating } = loaderData;
  const checkbox = "h-4 w-4 rounded border-line-alt text-accent focus:ring-accent";
  const showForm = tab === "products" && (!!editing || creating || products.length === 0);
  // The kind selector swaps the form's second half; live client state, seeded
  // from the record being edited (or ?kind= for a fresh form). Navigating
  // between "+ Gift voucher" / "+ Experience" / an edit link doesn't remount
  // this component, so re-seed whenever the source changes — otherwise the
  // selector keeps showing the previously opened kind.
  const kindParam = searchParams.get("kind");
  const seedKind: VoucherKind =
    editing?.kind ?? (kindParam === "package" ? "package" : kindParam === "experience" ? "experience" : "gift");
  const [kind, setKind] = useState<VoucherKind>(seedKind);
  const [briefMsg, setBriefMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setKind(seedKind), [seedKind, editing?.id]);

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">{t("voTitle")}</h1>
      <p className="mb-6 text-[14px] text-muted">
        {t("voIntro1")}{" "}
        <strong>{t("voIntroGift")}</strong> {t("voIntroGiftRest")}{" "}
        <strong>{t("voIntroPackages")}</strong> {t("voIntroPackagesRest")}{" "}
        <strong>{t("voIntroBooked")}</strong> {t("voIntroBookedRest")}
      </p>

      <div className="mb-6 flex gap-1 rounded-[10px] border border-line bg-surface p-1" style={{ width: "fit-content" }}>
        {([["products", t("voTabForSale")], ["sold", t("voTabSold", { n: tab === "sold" ? sold.length : "…" })]] as const).map(([tabId, label]) => (
          <Link
            key={tabId}
            to={tabId === "products" ? "/admin/vouchers" : "/admin/vouchers?tab=sold"}
            className={`rounded-[8px] px-4 py-2 text-[13.5px] font-semibold ${tab === tabId ? "bg-accent text-white" : "text-muted hover:text-ink"}`}
          >
            {label}
          </Link>
        ))}
      </div>

      {tab === "sold" ? (
        <>
        {/* Issue a free voucher (loyalty gesture, competition prize, service recovery). */}
        {compIssued && (
          <p className="mb-4 rounded-[10px] border border-[#cfe3d2] bg-[#eef6ef] px-4 py-2.5 text-[13px] font-semibold text-[#3f7a52]">
            {t("voCompIssuedPrefix")}{" "}
            <Link to={`/admin/vouchers/${compIssued}`} className="underline">
              {compIssued}
            </Link>{" "}
            {t("voCompIssuedSuffix")}
          </p>
        )}
        {products.length > 0 && (
          <details key={compIssued ?? "comp"} className="mb-5 rounded-[14px] border border-line bg-surface p-5">
            <summary className="cursor-pointer text-[14px] font-semibold text-secondary hover:text-accent">
              {t("voIssueComp")}
            </summary>
            <Form method="post" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <input type="hidden" name="intent" value="voucherComp" />
              <label className="block text-[13px] font-semibold text-secondary">
                {t("voVoucher")}
                <select name="productId" className={FIELD_INPUT}>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title} ({t(p.kind === "gift" ? "voKindGift" : p.kind === "package" ? "voKindPackage" : "voKindExperience")})
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-[13px] font-semibold text-secondary">
                {t("voRecipientName")}
                <input name="recipientName" className={FIELD_INPUT} />
              </label>
              <label className="block text-[13px] font-semibold text-secondary">
                {t("voRecipientEmail")} <span className="font-normal text-faint">{t("voRecipientEmailHint")}</span>
                <input name="recipientEmail" type="email" className={FIELD_INPUT} />
              </label>
              <label className="block text-[13px] font-semibold text-secondary">
                {t("voMessage")} <span className="font-normal text-faint">{t("voOptional")}</span>
                <input name="message" className={FIELD_INPUT} />
              </label>
              <div className="sm:col-span-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
                >
                  {t("voIssueFree")}
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
            {t("voNoSold")}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-[14px] border border-line bg-surface">
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="border-b border-line text-left text-[11.5px] uppercase tracking-wide text-muted-2">
                  <th className="px-3 py-3">{t("voThCode")}</th>
                  <th className="px-3 py-3">{t("voVoucher")}</th>
                  <th className="px-3 py-3">{t("voThBuyer")}</th>
                  <th className="px-3 py-3">{t("voThStatus")}</th>
                  <th className="px-3 py-3">{t("voThDates")}</th>
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody>
                {sold.map((v) => (
                  <tr key={v.code} className="border-b border-divider last:border-0">
                    <td className="whitespace-nowrap px-3 py-3 font-mono text-[12.5px] font-semibold">
                      <Link to={`/admin/vouchers/${v.code}`} className="text-accent-deep hover:underline">{v.code}</Link>
                    </td>
                    <td className="px-3 py-3">
                      {v.title}
                      {v.simulated && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-semibold text-amber-800">{t("voBadgeTest")}</span>}
                      {v.comp && <span className="ml-2 rounded-full bg-chip px-2 py-0.5 text-[10.5px] font-semibold text-muted">{t("voBadgeComp")}</span>}
                    </td>
                    <td className="px-3 py-3">
                      <div>{v.buyerName}{v.recipientName ? ` → ${v.recipientName}` : ""}</div>
                      <div className="text-[12px] text-muted-2">{v.buyerEmail}</div>
                    </td>
                    <td className="px-3 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${v.status === "active" ? "bg-[#e8f0e6] text-[#3f7a52]" : v.status === "redeemed" ? "bg-chip text-muted" : "bg-[#fbe9e7] text-[#c0392b]"}`}>
                        {t(`voStatus_${v.status}`)}
                      </span>
                      {v.balance != null && (
                        <div className="mt-1 text-[12px] text-muted">{t("voBalanceLeft", { amount: formatMoney(v.balance, currency) })}</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-[12.5px] text-muted">
                      <div>{fmtDate(v.purchasedAt, "d MMM yyyy", dl)}</div>
                      <div className="text-muted-2">→ {fmtDate(v.expiresAt, "d MMM yyyy", dl)}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right">
                      <Link to={`/admin/vouchers/${v.code}`} className="text-[12.5px] font-semibold text-accent hover:text-accent-deep">
                        {t("voView")}
                      </Link>
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
            {t("voNewGift")}
          </Link>
          <Link
            to="/admin/vouchers?new=1&kind=package"
            className="inline-block rounded-[10px] border border-accent px-5 py-3 text-[15px] font-semibold text-accent hover:bg-accent-soft"
          >
            {t("voNewPackage")}
          </Link>
          <Link
            to="/admin/vouchers?new=1&kind=experience"
            className="inline-block rounded-[10px] border border-accent px-5 py-3 text-[15px] font-semibold text-accent hover:bg-accent-soft"
          >
            {t("voNewExperience")}
          </Link>
        </div>
      )}

      {tab === "products" && !showForm && (
        <Form
          method="post"
          className="mb-7 flex flex-wrap items-end gap-4 rounded-[14px] border border-line bg-surface p-6"
        >
          <input type="hidden" name="intent" value="selfService" />
          <div className="min-w-[260px] flex-1">
            <h2 className="m-0 mb-1 font-serif text-[18px] font-semibold">{t("voSelfServiceTitle")}</h2>
            <p className="m-0 text-[13px] leading-[1.55] text-secondary">
              {t("voSelfServiceBody")}
            </p>
          </div>
          <label className="block text-[13px] font-semibold text-secondary">
            {t("voCoolingOff")}
            <input
              name="coolingOffDays"
              type="number"
              min={0}
              max={365}
              defaultValue={coolingOffDays}
              className={`${FIELD_INPUT} w-[130px]`}
            />
          </label>
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] border border-line-alt px-5 py-[11px] text-[14px] font-semibold text-secondary hover:bg-chip disabled:opacity-60"
          >
            {t("voSave")}
          </button>
        </Form>
      )}

      {showForm && (
        <Form
          method="post"
          encType="multipart/form-data"
          key={editing?.id ?? `new-${kindParam ?? "gift"}`}
          className="mb-7 flex flex-col gap-4 rounded-[14px] border border-line bg-surface p-6"
        >
          <input type="hidden" name="intent" value="save" />
          <input type="hidden" name="id" defaultValue={editing?.id ?? ""} />

          <div className="flex items-center justify-between">
            <h2 className="font-serif text-[18px] font-semibold">
              {editing ? t("voEditVoucher") : t("voNewVoucher")}
            </h2>
            {(editing || creating) && (
              <Link to="/admin/vouchers" className="text-[13px] font-semibold text-muted hover:text-accent">
                {t("voCancel")}
              </Link>
            )}
          </div>

          <label className="block text-[13px] font-semibold text-secondary">
            {t("voType")}
            <select
              name="kind"
              value={kind}
              onChange={(e) => setKind(e.target.value === "package" ? "package" : e.target.value === "experience" ? "experience" : "gift")}
              disabled={!!editing}
              className={FIELD_INPUT}
            >
              <option value="gift">{t("voTypeGift")}</option>
              <option value="package">{t("voTypePackage")}</option>
              <option value="experience">{t("voTypeExperience")}</option>
            </select>
            {editing ? (
              <input type="hidden" name="kind" value={editing.kind} />
            ) : null}
            {editing && (
              <span className="mt-1 block text-[11px] font-normal text-faint">
                {t("voTypeLocked")}
              </span>
            )}
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-[13px] font-semibold text-secondary">
              {t("voName")}
              <input
                name="title"
                defaultValue={editing?.title ?? ""}
                placeholder={kind === "package" ? t("voPhNamePackage") : kind === "experience" ? t("voPhNameExperience") : t("voPhNameGift")}
                className={FIELD_INPUT}
              />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              {t("voSalePrice")} ({currency})
              <input
                name="price"
                type="number"
                min={0}
                step="0.01"
                defaultValue={editing ? String(editing.price) : ""}
                placeholder={kind === "package" ? "249" : kind === "experience" ? "75" : "100"}
                className={FIELD_INPUT}
              />
            </label>
          </div>

          {kind === "gift" && (
            <label className="block text-[13px] font-semibold text-secondary">
              {t("voGiftValue")} ({currency}){" "}
              <span className="font-normal text-faint">{t("voGiftValueHint")}</span>
              <input
                name="value"
                type="number"
                min={0}
                step="0.01"
                defaultValue={editing?.value != null ? String(editing.value) : ""}
                placeholder={t("voPhSameAsPrice")}
                className={FIELD_INPUT}
              />
            </label>
          )}

          {kind === "experience" && (
            <label className="block text-[13px] font-semibold text-secondary sm:max-w-[240px]">
              {t("voGuests")} <span className="font-normal text-faint">{t("voGuestsHint")}</span>
              <input
                name="guests"
                type="number"
                min={1}
                max={50}
                defaultValue={editing?.guests != null ? String(editing.guests) : ""}
                className={FIELD_INPUT}
              />
            </label>
          )}

          <label className="block text-[13px] font-semibold text-secondary">
            {t("voDescription")} <span className="font-normal text-faint">{t("voDescriptionHint")}</span>
            <textarea
              name="description"
              rows={2}
              defaultValue={editing?.description ?? ""}
              placeholder={
                kind === "package"
                  ? t("voPhDescPackage")
                  : kind === "experience"
                    ? t("voPhDescExperience")
                    : t("voPhDescGift")
              }
              className={`${FIELD_INPUT} resize-y`}
            />
          </label>

          <div className="text-[13px] font-semibold text-secondary">
            {t("voPhoto")} <span className="font-normal text-faint">{t("voPhotoHint")}</span>
            <div className="mt-1.5 flex items-start gap-4">
              {editing?.image && (
                <div className="flex flex-none flex-col items-center gap-1.5">
                  <img src={editing.image} alt="" className="h-[72px] w-[104px] flex-none rounded-[10px] border border-line object-cover" />
                  <label className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
                    <input type="checkbox" name="removeImage" className={checkbox} />
                    {t("voRemove")}
                  </label>
                </div>
              )}
              <div className="w-full">
                <FilePicker name="image" accept="image/*" />
                <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={async (e) => {
                      const r = buildImageBrief(e.currentTarget.form!, kind, hotelName, currency, brandAccent, brandBg);
                      if ("missing" in r) {
                        // buildImageBrief reports the missing fields by their English form
                        // labels; map them to the translated labels at display point.
                        const fieldKeys: Record<string, string> = { Name: "voName", "Sale price": "voSalePrice", Description: "voDescription", Nights: "voNights" };
                        setBriefMsg({ ok: false, text: t("voBriefMissing", { fields: r.missing.map((m) => t(fieldKeys[m] ?? m)).join(", ") }) });
                        return;
                      }
                      try {
                        await navigator.clipboard.writeText(r.brief);
                        setBriefMsg({ ok: true, text: t("voBriefCopied") });
                      } catch {
                        setBriefMsg({ ok: false, text: t("voBriefClipboard") });
                      }
                    }}
                    className="rounded-[9px] border border-line-alt px-3.5 py-2 text-[12.5px] font-semibold text-secondary hover:bg-chip"
                  >
                    {t("voCopyBrief")}
                  </button>
                  <span className="text-[11.5px] font-normal text-faint">
                    {t("voCopyBriefHint")}
                  </span>
                </div>
                {briefMsg && (
                  <p className={`mb-0 mt-1.5 text-[12.5px] font-normal ${briefMsg.ok ? "text-[#3f7a52]" : "text-red-600"}`}>
                    {briefMsg.text}
                  </p>
                )}
              </div>
            </div>
          </div>

          {kind === "package" && (
            <fieldset className="flex flex-col gap-4 rounded-[12px] border border-line bg-surface-alt/40 p-4">
              <legend className="px-1 text-[13px] font-semibold text-secondary">{t("voTheStay")}</legend>
              <div className="grid grid-cols-3 gap-4">
                <label className="block text-[13px] font-semibold text-secondary">
                  {t("voNights")}
                  <input name="nights" type="number" min={1} max={30} defaultValue={editing?.package?.nights ?? 2} className={FIELD_INPUT} />
                </label>
                <label className="block text-[13px] font-semibold text-secondary">
                  {t("voAdults")}
                  <input name="adults" type="number" min={1} defaultValue={editing?.package?.adults ?? 2} className={FIELD_INPUT} />
                </label>
                <label className="block text-[13px] font-semibold text-secondary">
                  {t("voChildren")}
                  <input name="children" type="number" min={0} defaultValue={editing?.package?.children ?? ""} placeholder="0" className={FIELD_INPUT} />
                </label>
              </div>

              <div>
                <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-2">{t("voBookableRooms")}</div>
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
                    <span className="text-[12.5px] text-muted">{t("voNoRoomTypes")}</span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <label className="block text-[13px] font-semibold text-secondary">
                  {t("voWindowFrom")} <span className="font-normal text-faint">{t("voOptional")}</span>
                  <input name="windowFrom" type="date" defaultValue={editing?.package?.window?.from ?? ""} className={FIELD_INPUT} />
                </label>
                <label className="block text-[13px] font-semibold text-secondary">
                  {t("voWindowTo")} <span className="font-normal text-faint">{t("voOptional")}</span>
                  <input name="windowTo" type="date" defaultValue={editing?.package?.window?.to ?? ""} className={FIELD_INPUT} />
                </label>
              </div>

              <div>
                <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-2">
                  {t("voCheckinAllowed")}
                </div>
                <div className="flex flex-wrap gap-3">
                  {WEEKDAY_LABELS.map((_, d) => (
                    <label key={d} className="flex items-center gap-1.5 text-[13.5px] font-medium text-secondary">
                      <input
                        type="checkbox"
                        name="checkinDays"
                        value={d}
                        defaultChecked={editing?.package?.checkinDays.includes(d) ?? false}
                        className={checkbox}
                      />
                      {t(`voWd${d}`)}
                    </label>
                  ))}
                </div>
                <span className="mt-1 block text-[11px] font-normal text-faint">
                  {t("voCheckinHint")}
                </span>
              </div>

              <div className="block text-[13px] font-semibold text-secondary">
                {t("voBlockedDates")} <span className="font-normal text-faint">{t("voBlockedDatesHint")}</span>
                <BlockedRangesEditor name="blockedRanges" initial={editing?.package?.blockedRanges ?? []} />
              </div>
            </fieldset>
          )}

          <div className="grid grid-cols-2 gap-4">
            <label className="block text-[13px] font-semibold text-secondary">
              {t("voValidFor")}
              <input name="expiresMonths" type="number" min={1} max={60} defaultValue={editing?.expiresMonths ?? 12} className={FIELD_INPUT} />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              {t("voSaleLimit")} <span className="font-normal text-faint">{t("voOptional")}</span>
              <input name="cap" type="number" min={1} defaultValue={editing?.cap ?? ""} placeholder={t("voPhUnlimited")} className={FIELD_INPUT} />
            </label>
          </div>

          <label className="block text-[13px] font-semibold text-secondary">
            {t("voIncluded")} <span className="font-normal text-faint">{t("voIncludedHint")}</span>
            <textarea
              name="included"
              rows={4}
              defaultValue={(editing?.included ?? []).join("\n")}
              placeholder={t("voPhIncluded")}
              className={`${FIELD_INPUT} resize-y`}
            />
          </label>

          <label className="block text-[13px] font-semibold text-secondary">
            {t("voTerms")} <span className="font-normal text-faint">{t("voTermsHint")}</span>
            <textarea
              key={editing ? editing.id : `terms-${kind}`}
              name="terms"
              rows={3}
              defaultValue={editing ? (editing.terms ?? "") : DEFAULT_TERMS[kind]}
              className={`${FIELD_INPUT} resize-y`}
            />
          </label>

          <label className="flex items-center gap-2.5 text-[14px] font-semibold">
            <input type="checkbox" name="active" defaultChecked={editing ? editing.active : true} className={checkbox} />
            {t("voOnSale")}
          </label>

          {actionData?.error && <p className="text-[13px] text-red-600">{actionData.error}</p>}
          <div>
            <button
              type="submit"
              disabled={saving}
              className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
            >
              {saving ? t("saving") : editing ? t("voSaveVoucher") : t("voAddVoucher")}
            </button>
          </div>
        </Form>
      )}

      {products.length === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-6 text-[14px] text-secondary">
          {t("voNoProducts")}
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
                      {t(p.kind === "gift" ? "voKindGift" : p.kind === "package" ? "voKindPackage" : "voKindExperience")}
                    </span>
                    {p.active ? (
                      <span className="rounded-full bg-[#e8f0e6] px-2 py-0.5 text-[11px] font-semibold text-[#3f7a52]">{t("voBadgeOnSale")}</span>
                    ) : (
                      <span className="rounded-full bg-surface-alt px-2 py-0.5 text-[11px] font-semibold text-muted-2">{t("voBadgeHidden")}</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[12.5px] text-muted-2">{summary(p, currency, t)}</div>
                </div>
              </div>
              <div className="flex flex-none items-center gap-3">
                <Form method="post">
                  <input type="hidden" name="id" value={p.id} />
                  <button type="submit" name="intent" value="toggle" className="text-[13px] font-semibold text-muted hover:text-accent">
                    {p.active ? t("voHide") : t("voShow")}
                  </button>
                </Form>
                <Link to={`/admin/vouchers?edit=${p.id}`} className="text-[13px] font-semibold text-accent hover:underline">
                  {t("voEdit")}
                </Link>
                <Form method="post" onSubmit={(ev) => { if (!confirm(t("voConfirmDelete", { title: p.title }))) ev.preventDefault(); }}>
                  <input type="hidden" name="id" value={p.id} />
                  <button type="submit" name="intent" value="delete" className="text-[13px] font-semibold text-[#c0392b] hover:underline">
                    {t("voDelete")}
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
