// Bounded I/O for the request path. Dependency-free (apart from the per-request
// scope marker) so config.server.ts, d1.server.ts and the Worker entry can all
// import it without closing a cycle.
//
// Why this exists: on 2026-10-15 Cloudflare's logs showed admin requests held
// open for 10–27 minutes with ~3 ms of CPU and no response ever produced
// (`outcome: canceled`, wallTimeMs 641947 / 1652803). The handler was parked on
// an awaited KV/D1 call whose answer never arrived, so the customer's tab
// spun until they gave up. A binding call that never settles is not an error
// anything can catch, so every read on the request path gets a deadline: it
// either answers or turns into a rejection that names the call that stalled.
import { AsyncLocalStorage } from "node:async_hooks";

import { requestKvCache } from "./request-cache.server";

// What was this request waiting on? One trace per request (entered in
// workers/app.ts beside the KV cache). Every bounded KV/D1 call registers while
// it is in flight and leaves a one-line receipt when it settles, so the
// request-deadline log can say what was pending — or, when nothing was, that the
// stall is NOT a storage call (a never-settling promise, a render that never
// finishes) and where the request got to before it stopped.
const RECEIPTS_KEPT = 12;

interface IoTrace {
  startedAt: number;
  nextId: number;
  inflight: Map<number, { label: string; at: number }>;
  receipts: string[];
}

const traceStore = new AsyncLocalStorage<IoTrace>();

/** Enter a fresh trace scope for one request. Cron stays outside it. */
export function runWithIoTrace<T>(fn: () => T): T {
  return traceStore.run({ startedAt: Date.now(), nextId: 0, inflight: new Map(), receipts: [] }, fn);
}

function beginTraced(label: string): ((outcome: string) => void) | undefined {
  const trace = traceStore.getStore();
  if (!trace) return undefined;
  const id = trace.nextId++;
  const at = Date.now();
  trace.inflight.set(id, { label, at });
  return (outcome) => {
    trace.inflight.delete(id);
    trace.receipts.push(`${label} ${outcome} ${Date.now() - at}ms @+${at - trace.startedAt}ms`);
    if (trace.receipts.length > RECEIPTS_KEPT) trace.receipts.shift();
  };
}

/** One line for the deadline log: what is still pending, and what finished last. */
export function describeIoTrace(trace: IoTrace | undefined = traceStore.getStore()): string {
  if (!trace) return "no io trace";
  const now = Date.now();
  const pending = [...trace.inflight.values()].map((p) => `${p.label} (pending ${now - p.at}ms, started @+${p.at - trace.startedAt}ms)`);
  return [
    pending.length ? `in flight: ${pending.join("; ")}` : "in flight: NOTHING (not a KV/D1 stall)",
    trace.receipts.length ? `last settled: ${trace.receipts.join(" | ")}` : "no KV/D1 call ever settled",
  ].join(" -- ");
}

/** Settle with `work`, or reject after `ms` — the timer is cleared either way so
 *  it never keeps an isolate alive on its own. The underlying call is NOT
 *  cancelled (bindings have no abort); it is simply no longer awaited. */
export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = beginTraced(label);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IoTimeoutError(`${label} did not respond within ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout])
    .then(
      (value) => {
        end?.("ok");
        return value;
      },
      (error) => {
        end?.(error instanceof IoTimeoutError ? "TIMEOUT" : "error");
        throw error;
      },
    )
    .finally(() => clearTimeout(timer));
}

export class IoTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IoTimeoutError";
  }
}

/** A KV read that answers in well under 100 ms normally; this is the "it is
 *  never coming back" bound, not a latency budget. */
export const KV_READ_TIMEOUT_MS = 4_000;
export const KV_READ_ATTEMPTS = 2;
/** One D1 statement. Generous: the slowest admin query measured is ~1 s. */
export const D1_STATEMENT_TIMEOUT_MS = 12_000;
export const D1_BATCH_TIMEOUT_MS = 20_000;

/**
 * Run an IDEMPOTENT read with a deadline, re-issuing it if the first attempt
 * never answers. Re-issuing is the useful half: a lost response is almost
 * always lost for that one call, and the second call goes through. A rejection
 * from the read itself (not a timeout) is not retried — it is a real answer.
 * Never use this for a write.
 */
export async function boundedRead<T>(
  label: string,
  read: () => Promise<T>,
  { ms = KV_READ_TIMEOUT_MS, attempts = KV_READ_ATTEMPTS }: { ms?: number; attempts?: number } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTimeout(read(), ms, label);
    } catch (error) {
      if (!(error instanceof IoTimeoutError)) throw error;
      console.error(`[io-timeout] ${error.message} (attempt ${attempt}/${attempts})`);
      if (attempt >= attempts) throw error;
    }
  }
}

const isReadSql = (sql: string) => /^\s*(select|with|explain|pragma)\b/i.test(sql);
const shortSql = (sql: string) => sql.replace(/\s+/g, " ").trim().slice(0, 80);

type AnyFn = (...args: unknown[]) => unknown;
/** Wrapped statement -> the real one, so batch() hands D1 what D1 issued. */
const unwrap = new WeakMap<object, object>();

function boundStatement(stmt: D1PreparedStatement, sql: string): D1PreparedStatement {
  const read = isReadSql(sql);
  const wrapped = new Proxy(stmt, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      const fn = v as AnyFn;
      if (prop === "bind") {
        return (...args: unknown[]) => boundStatement(fn.apply(target, args) as D1PreparedStatement, sql);
      }
      if (prop === "first" || prop === "all" || prop === "raw" || prop === "run") {
        const label = `D1 ${String(prop)} "${shortSql(sql)}"`;
        return (...args: unknown[]) =>
          read
            ? boundedRead(label, () => fn.apply(target, args) as Promise<unknown>, { ms: D1_STATEMENT_TIMEOUT_MS })
            : withTimeout(fn.apply(target, args) as Promise<unknown>, D1_STATEMENT_TIMEOUT_MS, label);
      }
      return fn.bind(target);
    },
  });
  unwrap.set(wrapped, stmt);
  return wrapped;
}

/** D1 with a deadline on every statement. Reads are re-issued once if they never
 *  answer; writes (including batches, which may mix them) are only bounded —
 *  repeating one that may have landed is not safe. */
export function boundD1(d1: D1Database): D1Database {
  return new Proxy(d1, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      const fn = v as AnyFn;
      if (prop === "prepare") {
        return (sql: string) => boundStatement(fn.call(target, sql) as D1PreparedStatement, sql);
      }
      if (prop === "batch") {
        return (stmts: object[]) =>
          withTimeout(
            fn.call(target, stmts.map((s) => unwrap.get(s) ?? s)) as Promise<unknown>,
            D1_BATCH_TIMEOUT_MS,
            `D1 batch of ${stmts.length}`,
          );
      }
      if (prop === "exec") {
        return (sql: string) =>
          withTimeout(fn.call(target, sql) as Promise<unknown>, D1_BATCH_TIMEOUT_MS, `D1 exec "${shortSql(sql)}"`);
      }
      return fn.bind(target);
    },
  });
}

/** Bound D1 only while serving a request. Cron and queue work (pruning a
 *  337 MB table, the Google ARI push) legitimately runs long and is outside
 *  the per-request scope on purpose — see workers/app.ts. */
export function boundD1ForRequest(d1: D1Database | undefined): D1Database | undefined {
  return d1 && requestKvCache() ? boundD1(d1) : d1;
}

/** Hard ceiling on how long a page or data request may take to PRODUCE its
 *  response (headers) — body streaming is unaffected, so large images and feeds
 *  are fine. Whatever is stuck keeps running in the background; the browser gets
 *  an answer it can retry instead of a tab that spins for half an hour. */
export const REQUEST_DEADLINE_MS = 30_000;

export function withRequestDeadline(request: Request, work: Promise<Response>): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const trace = traceStore.getStore();
  const expired = new Promise<Response>((resolve) => {
    timer = setTimeout(() => {
      console.error(
        `[request-deadline] ${request.method} ${request.url} produced no response in ${REQUEST_DEADLINE_MS} ms -- ${describeIoTrace(trace)}`,
      );
      resolve(
        new Response("This page took too long to load. Please try again.", {
          status: 503,
          headers: { "Retry-After": "2", "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
        }),
      );
    }, REQUEST_DEADLINE_MS);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
