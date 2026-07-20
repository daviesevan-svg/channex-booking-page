// Voucher storage. Two stores, deliberately different:
//
// - CATALOG (what a hotel offers for sale): KV blob `voucher_products:{pid}`,
//   ordered VoucherProduct[] — the extras.server.ts pattern. Admin-only writes,
//   no concurrency to speak of.
// - SOLD VOUCHERS (money-bearing, concurrent): D1 table `voucher`, one row per
//   voucher — the bookings.server.ts pattern. Creation is an atomic claim
//   (INSERT … ON CONFLICT DO NOTHING keyed pid+code) so the Stripe return URL
//   and webhook can both finalize without double-issuing; mutations
//   (redemptions, balance) go through an optimistic CAS on the exact old JSON
//   so concurrent redemptions can't double-spend.
import { getConfigKV, getDB } from "./config.server";
import { clientKey, overLimit, rateLimit } from "./rate-limit.server";
import { createRefund } from "./stripe.server";
import {
  displayStatus,
  giftBalance,
  normalizeVoucherCode,
  selfCancelDisallowedReason,
  type VoucherProduct,
  type VoucherRecord,
} from "./vouchers";

export type { VoucherProduct, VoucherRecord } from "./vouchers";

// ---------- catalog (KV) ----------

const productsKey = (pid: string) => `voucher_products:${pid}`;

export async function getVoucherProducts(pid: string): Promise<VoucherProduct[]> {
  const kv = getConfigKV();
  if (!kv) return [];
  const raw = await kv.get(productsKey(pid));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as VoucherProduct[];
    return Array.isArray(arr) ? arr.sort((a, b) => a.position - b.position) : [];
  } catch {
    return [];
  }
}

/** Active products only, for the guest-facing shop. */
export async function getActiveVoucherProducts(pid: string): Promise<VoucherProduct[]> {
  return (await getVoucherProducts(pid)).filter((p) => p.active);
}

export async function getVoucherProduct(pid: string, id: string): Promise<VoucherProduct | undefined> {
  return (await getVoucherProducts(pid)).find((p) => p.id === id);
}

async function writeProducts(pid: string, list: VoucherProduct[]): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(productsKey(pid), JSON.stringify(list));
}

export async function saveVoucherProduct(pid: string, product: VoucherProduct): Promise<void> {
  const list = await getVoucherProducts(pid);
  const i = list.findIndex((p) => p.id === product.id);
  if (i === -1) list.push(product);
  else list[i] = product;
  await writeProducts(pid, list);
}

export async function deleteVoucherProduct(pid: string, id: string): Promise<void> {
  await writeProducts(pid, (await getVoucherProducts(pid)).filter((p) => p.id !== id));
}

export async function toggleVoucherProduct(pid: string, id: string): Promise<void> {
  const list = await getVoucherProducts(pid);
  const p = list.find((x) => x.id === id);
  if (!p) return;
  p.active = !p.active;
  await writeProducts(pid, list);
}

// ---------- sold vouchers (D1) ----------

function db(): D1Database {
  const d = getDB();
  if (!d) throw new Error("D1 database (binding DB) is not configured.");
  return d;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await db()
    .prepare(
      `CREATE TABLE IF NOT EXISTS voucher (
        pid TEXT NOT NULL, code TEXT NOT NULL, id TEXT NOT NULL,
        product_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY (pid, code)
      )`,
    )
    .run();
  schemaReady = true;
}

const parse = (row: { json: string } | null): VoucherRecord | null =>
  row ? (JSON.parse(row.json) as VoucherRecord) : null;

/** Atomically create a voucher. The (pid, code) primary key is the
 *  finalize-once latch: when the Stripe return URL and the webhook both try to
 *  issue the same pending purchase (same pre-generated code), exactly one wins;
 *  the loser gets the existing record untouched. */
export async function claimVoucher(
  pid: string,
  record: VoucherRecord,
): Promise<{ won: boolean; existing?: VoucherRecord }> {
  await ensureSchema();
  const res = await db()
    .prepare(
      `INSERT INTO voucher (pid, code, id, product_id, kind, status, created_at, expires_at, json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (pid, code) DO NOTHING`,
    )
    .bind(
      pid,
      record.code,
      record.id,
      record.productId,
      record.kind,
      record.status,
      record.purchasedAt,
      record.expiresAt,
      JSON.stringify(record),
    )
    .run();
  if (res.meta.changes === 1) return { won: true };
  return { won: false, existing: (await getVoucherByCode(pid, record.code)) ?? undefined };
}

/** Voucher-code lookup with a per-IP brute-force throttle. The code is a
 *  bearer credential, so guessing must stay expensive: once a client racks up
 *  `LOOKUP_MISS_LIMIT` misses inside the window, further lookups from that IP
 *  are refused before touching D1. Successful lookups never count against the
 *  limit, so legitimate holders are unaffected until an attacker on the same
 *  IP exhausts it. Returns "limited" when throttled. */
const LOOKUP_MISS_LIMIT = 10;
const LOOKUP_WINDOW_SEC = 600;
export async function lookupVoucherGuarded(
  pid: string,
  rawCode: string,
  request: Request,
): Promise<VoucherRecord | null | "limited"> {
  const bucket = `vprobe:${pid}:${clientKey(request)}`;
  if (await overLimit(bucket, LOOKUP_MISS_LIMIT)) return "limited";
  const v = await getVoucherByCode(pid, normalizeVoucherCode(rawCode));
  if (!v) await rateLimit(bucket, LOOKUP_MISS_LIMIT, LOOKUP_WINDOW_SEC);
  return v;
}

export async function getVoucherByCode(pid: string, code: string): Promise<VoucherRecord | null> {
  await ensureSchema();
  const row = await db()
    .prepare(`SELECT json FROM voucher WHERE pid = ? AND code = ?`)
    .bind(pid, code)
    .first<{ json: string }>();
  return parse(row);
}

/** All sold vouchers for the admin list, newest first. */
export async function listVouchers(pid: string): Promise<VoucherRecord[]> {
  await ensureSchema();
  const { results } = await db()
    .prepare(`SELECT json FROM voucher WHERE pid = ? ORDER BY created_at DESC`)
    .bind(pid)
    .all<{ json: string }>();
  return (results ?? []).map((r) => JSON.parse(r.json) as VoucherRecord);
}

/** Every voucher bought with this email — powers the guest self-service list.
 *  Filters in code (per-property voucher counts are small; no email column). */
export async function listVouchersByEmail(pid: string, email: string): Promise<VoucherRecord[]> {
  const norm = email.trim().toLowerCase();
  return (await listVouchers(pid)).filter((v) => v.buyer.email.trim().toLowerCase() === norm);
}

/** How many vouchers of a product have been sold (for the sale cap). Counts
 *  every non-cancelled voucher — a redeemed voucher still consumed a unit. */
export async function soldCount(pid: string, productId: string): Promise<number> {
  await ensureSchema();
  const row = await db()
    .prepare(`SELECT COUNT(*) AS n FROM voucher WHERE pid = ? AND product_id = ? AND status != 'cancelled'`)
    .bind(pid, productId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Optimistic compare-and-swap update: applies `next` only if the stored JSON
 *  still equals `prev`'s serialization. Returns the updated record, or null if
 *  a concurrent writer got there first (caller should re-read and retry or
 *  surface a conflict). This is what makes double-spending a gift balance or
 *  double-redeeming a package impossible. */
export async function casUpdateVoucher(
  pid: string,
  prev: VoucherRecord,
  next: VoucherRecord,
): Promise<VoucherRecord | null> {
  await ensureSchema();
  const res = await db()
    .prepare(`UPDATE voucher SET status = ?, expires_at = ?, json = ? WHERE pid = ? AND code = ? AND json = ?`)
    .bind(next.status, next.expiresAt, JSON.stringify(next), pid, next.code, JSON.stringify(prev))
    .run();
  return res.meta.changes === 1 ? next : null;
}

/** Read → mutate → CAS, retried a few times so a concurrent write doesn't fail
 *  the caller when the mutation is still valid against the fresh record. The
 *  mutator returns null to signal "no longer valid" (e.g. balance gone). */
async function casMutate(
  pid: string,
  code: string,
  mutate: (v: VoucherRecord) => VoucherRecord | null,
): Promise<{ ok: true; voucher: VoucherRecord } | { ok: false }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const v = await getVoucherByCode(pid, code);
    if (!v) return { ok: false };
    const next = mutate(v);
    if (!next) return { ok: false };
    const written = await casUpdateVoucher(pid, v, next);
    if (written) return { ok: true, voucher: written };
  }
  return { ok: false };
}

// ---------- gift-voucher checkout lifecycle: hold → settle / release ----------

/** Reserve part of a gift voucher's balance for a checkout in flight. The hold
 *  counts against the spendable balance (giftBalance) until it's settled,
 *  released, or its TTL passes (abandoned checkout — no sweep needed, expired
 *  holds simply stop counting). */
export async function holdGiftAmount(
  pid: string,
  code: string,
  ref: string,
  amount: number,
  ttlMs: number,
): Promise<{ ok: boolean }> {
  const r = await casMutate(pid, code, (v) => {
    if (v.kind !== "gift" || displayStatus(v) !== "active") return null;
    if (giftBalance(v) < amount) return null;
    return {
      ...v,
      redemptions: [
        ...v.redemptions,
        { at: new Date().toISOString(), amount, ref, pendingUntil: new Date(Date.now() + ttlMs).toISOString() },
      ],
    };
  });
  return { ok: r.ok };
}

/** Convert a hold into a real spend once its booking finalized. */
export async function settleGiftHold(pid: string, code: string, ref: string, bookingId: string): Promise<void> {
  await casMutate(pid, code, (v) => {
    const i = v.redemptions.findIndex((r) => r.ref === ref && !r.bookingId);
    if (i === -1) return null; // already settled/released
    const entry = v.redemptions[i];
    const redemptions = v.redemptions.slice();
    redemptions[i] = { at: entry.at, amount: entry.amount, ref, bookingId };
    return {
      ...v,
      balance: Math.max(0, Math.round(((v.balance ?? 0) - (entry.amount ?? 0)) * 100) / 100),
      redemptions,
    };
  });
}

/** Drop a hold whose checkout didn't complete. */
export async function releaseGiftHold(pid: string, code: string, ref: string): Promise<void> {
  await casMutate(pid, code, (v) => {
    const next = v.redemptions.filter((r) => !(r.ref === ref && !r.bookingId));
    if (next.length === v.redemptions.length) return null;
    return { ...v, redemptions: next };
  });
}

// ---------- buyer self-service: cooling-off cancel + refund ----------

/** Cancel by the buyer inside the cooling-off window. The eligibility rules are
 *  re-checked inside the CAS loop, so a redemption that lands concurrently
 *  can't be cancelled away. */
export async function selfCancelVoucher(
  pid: string,
  code: string,
  coolingOffDays: number,
  by: string,
): Promise<{ ok: true; voucher: VoucherRecord } | { ok: false; reason: "status" | "spent" | "window" | "conflict" }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const v = await getVoucherByCode(pid, code);
    if (!v) return { ok: false, reason: "status" };
    const reason = selfCancelDisallowedReason(v, coolingOffDays);
    if (reason) return { ok: false, reason };
    const next: VoucherRecord = {
      ...v,
      status: "cancelled",
      redemptions: [...v.redemptions, { at: new Date().toISOString(), by, note: "cooling-off cancel" }],
    };
    const written = await casUpdateVoucher(pid, v, next);
    if (written) return { ok: true, voucher: written };
  }
  return { ok: false, reason: "conflict" };
}

/** Refund a voucher's Stripe charge (full). Idempotent per voucher code; a
 *  no-op for simulated/comp vouchers (no charge) or already-refunded ones.
 *  Never throws — a failed refund is logged and reported so the hotel can
 *  handle it manually. */
export async function refundVoucherCharge(
  pid: string,
  v: VoucherRecord,
  by: string,
): Promise<{ ok: true; amount: number } | { ok: false; reason: "no_charge" | "already_refunded" | "error" }> {
  const p = v.payment;
  if (!p || !p.paymentIntentId || !p.accountId) return { ok: false, reason: "no_charge" };
  if (p.refund) return { ok: false, reason: "already_refunded" };
  try {
    const refund = await createRefund(p.accountId, p.paymentIntentId, undefined, `refund_v_${v.code}`);
    const amount = (refund.amount ?? Math.round((p.amount ?? v.product.price) * 100)) / 100;
    await casMutate(pid, v.code, (cur) =>
      cur.payment && !cur.payment.refund
        ? {
            ...cur,
            payment: {
              ...cur.payment,
              refund: {
                id: refund.id,
                amount,
                currency: refund.currency?.toUpperCase() ?? p.currency,
                at: new Date().toISOString(),
                by,
              },
            },
          }
        : null,
    );
    return { ok: true, amount };
  } catch (e) {
    console.log(`[vouchers] refund failed for ${v.code} pi=${p.paymentIntentId}: ${e instanceof Error ? e.message : e}`);
    return { ok: false, reason: "error" };
  }
}

/** Set/replace the gift recipient's email (buyer adding it later so the
 *  voucher — or a reminder — can be emailed to them directly). */
export async function setGiftRecipientEmail(pid: string, code: string, email: string): Promise<VoucherRecord | null> {
  const r = await casMutate(pid, code, (v) => (v.gift ? { ...v, gift: { ...v.gift, recipientEmail: email } } : null));
  return r.ok ? r.voucher : null;
}

// ---------- admin management ----------

/** Amend a sold voucher's redemption terms — expiry, and for packages the
 *  stay window + blocked dates. The snapshot is deliberate (catalog edits
 *  must never touch sold vouchers), so this is the explicit, audited path:
 *  every change lands in `edits[]` with who/when and the before/after.
 *  Extending the expiry of a lapsed-but-active voucher revives it, since
 *  "expired" is derived from the date at read time. */
export async function updateVoucherTerms(
  pid: string,
  code: string,
  next: {
    expiresAt?: string;
    window?: { from?: string; to?: string };
    blockedRanges?: { from: string; to: string }[];
  },
  by: string,
): Promise<{ ok: true; voucher: VoucherRecord; changed: number } | { ok: false }> {
  let changed = 0;
  const r = await casMutate(pid, code, (v) => {
    if (v.status !== "active") return null; // redeemed/cancelled terms are history
    const changes: { field: string; from: string; to: string }[] = [];
    const out: VoucherRecord = { ...v, product: { ...v.product } };

    if (next.expiresAt && next.expiresAt !== v.expiresAt) {
      changes.push({ field: "expires", from: v.expiresAt.slice(0, 10), to: next.expiresAt.slice(0, 10) });
      out.expiresAt = next.expiresAt;
    }
    if (v.product.package) {
      const pkg = { ...v.product.package };
      if (next.window !== undefined) {
        const fmt = (w?: { from?: string; to?: string }) => `${w?.from ?? "…"} – ${w?.to ?? "…"}`;
        if (fmt(next.window) !== fmt(pkg.window)) {
          changes.push({ field: "stay window", from: fmt(pkg.window), to: fmt(next.window) });
          pkg.window = next.window.from || next.window.to ? next.window : undefined;
        }
      }
      if (next.blockedRanges !== undefined) {
        const fmt = (rs: { from: string; to: string }[]) =>
          rs.length ? rs.map((x) => (x.from === x.to ? x.from : `${x.from}..${x.to}`)).join(", ") : "none";
        if (fmt(next.blockedRanges) !== fmt(pkg.blockedRanges)) {
          changes.push({ field: "blocked dates", from: fmt(pkg.blockedRanges), to: fmt(next.blockedRanges) });
          pkg.blockedRanges = next.blockedRanges;
        }
      }
      out.product.package = pkg;
    }

    if (changes.length === 0) return null; // nothing to write
    changed = changes.length;
    out.edits = [...(v.edits ?? []), { at: new Date().toISOString(), by, changes }];
    return out;
  });
  return r.ok ? { ok: true, voucher: r.voucher, changed } : { ok: false };
}

export async function cancelVoucher(pid: string, code: string): Promise<boolean> {
  return (await casMutate(pid, code, (v) => (v.status === "active" ? { ...v, status: "cancelled" } : null))).ok;
}

/** Mark a package or experience voucher redeemed by hand — a phone/desk
 *  booking, or the guest presenting an experience voucher (Day Pass, Spa,
 *  Dinner) in person. Gift vouchers are balance-based (use deductGift). */
export async function manualRedeemVoucher(pid: string, code: string, by: string): Promise<boolean> {
  return (
    await casMutate(pid, code, (v) =>
      v.kind !== "gift" && v.status === "active"
        ? { ...v, status: "redeemed", redemptions: [...v.redemptions, { at: new Date().toISOString(), by, note: "manual" }] }
        : null,
    )
  ).ok;
}

/** Deduct from a gift voucher by hand (spent at the desk). */
export async function deductGift(pid: string, code: string, amount: number, by: string): Promise<boolean> {
  return (
    await casMutate(pid, code, (v) => {
      if (v.kind !== "gift" || displayStatus(v) !== "active") return null;
      if (!(amount > 0) || giftBalance(v) < amount) return null;
      return {
        ...v,
        balance: Math.max(0, Math.round(((v.balance ?? 0) - amount) * 100) / 100),
        redemptions: [...v.redemptions, { at: new Date().toISOString(), amount, by, note: "manual" }],
      };
    })
  ).ok;
}
