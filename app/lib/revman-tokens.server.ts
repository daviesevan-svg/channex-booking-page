// Rate-intelligence token wallet. Competitor-price capture is metered: one
// token = one day of comp-set prices captured (a single area-search scrape that
// returns every competitor + our own hotel for that date). Hotels pre-pay for
// tokens; each scheduled capture debits one. Balance hits zero → capture pauses
// (the scheduler checks before spending) and the hotel is prompted to top up.
//
// Payments are manual/invoice for now: a superadmin credits tokens after a hotel
// pays out-of-band. A self-serve Stripe top-up is a later phase — it will simply
// call creditTokens() from the webhook, so nothing here changes.
//
// Money-safety: debit is a single conditional UPDATE (`balance >= n`) so it can
// never drive a wallet negative even under concurrent captures; the ledger row
// is written only when the debit actually applied. Every movement is recorded in
// an immutable ledger for audit.
import { getDB } from "./config.server";

function db(): D1Database {
  const d = getDB();
  if (!d) throw new Error("D1 database (binding DB) is not configured.");
  return d;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await db().batch([
    db().prepare(
      `CREATE TABLE IF NOT EXISTS rev_token_wallet (
        pid TEXT PRIMARY KEY,
        balance INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,
    ),
    db().prepare(
      `CREATE TABLE IF NOT EXISTS rev_token_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pid TEXT NOT NULL,
        delta INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        reason TEXT NOT NULL,
        note TEXT,
        actor TEXT,
        created_at TEXT NOT NULL
      )`,
    ),
    db().prepare(`CREATE INDEX IF NOT EXISTS rev_token_ledger_pid_ts ON rev_token_ledger (pid, created_at)`),
  ]);
  schemaReady = true;
}

/** Reason codes for ledger movements (kept small + stable). */
export type TokenReason = "credit_manual" | "credit_stripe" | "capture" | "refund" | "adjustment";

export interface LedgerEntry {
  id: number;
  delta: number;
  balanceAfter: number;
  reason: TokenReason;
  note: string | null;
  actor: string | null;
  createdAt: string;
}

export async function getBalance(pid: string): Promise<number> {
  await ensureSchema();
  const row = await db().prepare(`SELECT balance FROM rev_token_wallet WHERE pid = ?`).bind(pid).first<{ balance: number }>();
  return row?.balance ?? 0;
}

/** Adds tokens (a purchase / manual credit / refund). Amount must be positive.
 *  Upserts the wallet, then records the ledger row. Returns the new balance. */
export async function creditTokens(
  pid: string,
  amount: number,
  opts: { reason: TokenReason; note?: string; actor?: string },
): Promise<number> {
  await ensureSchema();
  const n = Math.floor(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Credit amount must be a positive whole number of tokens.");
  const now = new Date().toISOString();
  await db()
    .prepare(
      `INSERT INTO rev_token_wallet (pid, balance, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(pid) DO UPDATE SET balance = balance + excluded.balance, updated_at = excluded.updated_at`,
    )
    .bind(pid, n, now)
    .run();
  const balance = await getBalance(pid);
  await recordLedger(pid, n, balance, opts.reason, opts.note, opts.actor, now);
  return balance;
}

/** Spends tokens. The conditional UPDATE guarantees the balance never goes
 *  negative (returns ok:false when there aren't enough). Ledger is written only
 *  when the debit actually applied. */
export async function debitTokens(
  pid: string,
  amount: number,
  opts: { reason: TokenReason; note?: string; actor?: string },
): Promise<{ ok: boolean; balance: number }> {
  await ensureSchema();
  const n = Math.floor(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Debit amount must be a positive whole number of tokens.");
  const now = new Date().toISOString();
  const res = await db()
    .prepare(`UPDATE rev_token_wallet SET balance = balance - ?, updated_at = ? WHERE pid = ? AND balance >= ?`)
    .bind(n, now, pid, n)
    .run();
  if (!res.meta.changes) {
    return { ok: false, balance: await getBalance(pid) };
  }
  const balance = await getBalance(pid);
  await recordLedger(pid, -n, balance, opts.reason, opts.note, opts.actor, now);
  return { ok: true, balance };
}

async function recordLedger(
  pid: string,
  delta: number,
  balanceAfter: number,
  reason: TokenReason,
  note: string | undefined,
  actor: string | undefined,
  now: string,
): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO rev_token_ledger (pid, delta, balance_after, reason, note, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(pid, delta, balanceAfter, reason, note ?? null, actor ?? null, now)
    .run();
}

export async function getLedger(pid: string, limit = 20): Promise<LedgerEntry[]> {
  await ensureSchema();
  const { results } = await db()
    .prepare(
      `SELECT id, delta, balance_after AS balanceAfter, reason, note, actor, created_at AS createdAt
       FROM rev_token_ledger WHERE pid = ? ORDER BY id DESC LIMIT ?`,
    )
    .bind(pid, limit)
    .all<LedgerEntry>();
  return results ?? [];
}
