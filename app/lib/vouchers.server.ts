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
import type { VoucherProduct, VoucherRecord } from "./vouchers";

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
    .prepare(`UPDATE voucher SET status = ?, json = ? WHERE pid = ? AND code = ? AND json = ?`)
    .bind(next.status, JSON.stringify(next), pid, next.code, JSON.stringify(prev))
    .run();
  return res.meta.changes === 1 ? next : null;
}
