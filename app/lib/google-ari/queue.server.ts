import { DurableObject } from "cloudflare:workers";
import { mergeAriScopes } from "./scope";
import { performGoogleAriSync, blockOnGoogle, ALL_SYNC_KINDS, type AriPushResult } from "./push.server";
import type { GoogleAriWork } from "./queue-client.server";

type Work = GoogleAriWork & { revision: number };
interface State {
  revision: number;
  pending?: Work;
  inflight?: Work;
  disabled?: boolean;
  attempts: number;
}
interface Attempt { revision: number; results: AriPushResult[] }
const STATE = "queue";
const SOON_MS = 1_000;
const RECOVERY_MS = 60_000;
// 5s·2^n backoff capped at 1h: eight attempts span roughly two hours.
const MAX_ATTEMPTS = 8;

/** Merge scopes, not captured prices: every attempt reads the latest committed
 * inventory. Explicit disable wins until an explicit enable arrives. */
export function mergeGoogleAriWork(older: Work | undefined, newer: Work): Work {
  if (!older || newer.transition === "disable") return newer;
  if (newer.transition === "enable") return { ...newer, kinds: ALL_SYNC_KINDS, scope: undefined };
  if (older.transition === "disable") return { ...older, revision: newer.revision };
  const kinds = ALL_SYNC_KINDS.filter((kind) => older.kinds.includes(kind) || newer.kinds.includes(kind));
  const scope = !older.kinds.includes("ari") ? newer.scope : !newer.kinds.includes("ari") ? older.scope : mergeAriScopes(older.scope, newer.scope);
  return { ...older, revision: newer.revision, kinds, scope };
}

/** One durable actor per property. Only the short storage transactions exclude
 * interleaving; network delivery leaves enqueue requests free to persist newer
 * work. `active` serializes alarm/manual runners in the live instance. Pending
 * and inflight records plus a recovery alarm survive restarts. */
export class GoogleAriQueue extends DurableObject<Env> {
  private active?: Promise<Attempt | undefined>;

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("POST required", { status: 405 });
    const work = await request.json() as GoogleAriWork;
    if (!work.pid || !Array.isArray(work.kinds) || work.kinds.some((k) => !ALL_SYNC_KINDS.includes(k))) {
      return new Response("Invalid work", { status: 400 });
    }
    const revision = await this.ctx.storage.transaction(async (tx) => {
      const state = await tx.get<State>(STATE) ?? { revision: 0, attempts: 0 };
      // A repeat disable has nothing to add: the block is already queued or
      // delivered, and re-posting the whole stop-sell grid per settings save
      // would only feed Google duplicates.
      if (work.transition === "disable" && state.disabled && !state.pending) return null;
      if (work.transition === "disable") state.disabled = true;
      if (work.transition === "enable") state.disabled = false;
      // A channel notification must never reopen an explicitly disabled hotel,
      // including when its settings read raced the OFF save.
      if (state.disabled && work.transition !== "disable") return null;
      const revision = ++state.revision;
      state.pending = mergeGoogleAriWork(state.pending, { ...work, revision });
      await tx.put(STATE, state);
      const alarm = await tx.getAlarm();
      if (alarm === null || alarm > Date.now() + SOON_MS) await tx.setAlarm(Date.now() + SOON_MS);
      return revision;
    });
    if (revision === null) return Response.json({ queued: false, results: [{ kind: "ari", ok: false, detail: "Google ARI is explicitly disabled." }] });
    if (new URL(request.url).pathname !== "/run") return Response.json({ queued: true });
    // A manual sync can join an older delivery, then run the newer merged
    // request. Return its actual outcome, while failures remain durably queued.
    for (;;) {
      const attempt = await this.process();
      if (!attempt || attempt.revision >= revision) return Response.json({ results: attempt?.results ?? [] });
    }
  }

  async alarm(): Promise<void> { await this.process(); }

  private process(): Promise<Attempt | undefined> {
    if (!this.active) this.active = this.deliver().finally(() => { this.active = undefined; });
    return this.active;
  }

  private async deliver(): Promise<Attempt | undefined> {
    const work = await this.ctx.storage.transaction(async (tx) => {
      const state = await tx.get<State>(STATE);
      if (!state?.pending && !state?.inflight) { await tx.deleteAlarm(); return undefined; }
      // An inflight item means the instance restarted before acknowledgement.
      // Combine it with newer work and rebuild from storage, never retry XML
      // captured before the newer change.
      const work = state!.pending ? mergeGoogleAriWork(state!.inflight, state!.pending) : state!.inflight!;
      state!.inflight = work;
      delete state!.pending;
      await tx.put(STATE, state!);
      await tx.setAlarm(Date.now() + RECOVERY_MS);
      return work;
    });
    if (!work) return undefined;
    let results: AriPushResult[];
    try {
      results = work.transition === "disable"
        ? await blockOnGoogle(work.pid)
        : await performGoogleAriSync(work.pid, work.kinds, work.scope);
    } catch (error) {
      results = [{ kind: "ari", ok: false, detail: error instanceof Error ? error.message : String(error) }];
    }
    const ok = results.length > 0 && results.every((r) => r.ok);
    await this.ctx.storage.transaction(async (tx) => {
      const state = await tx.get<State>(STATE);
      if (!state) throw new Error("Google ARI queue state disappeared during delivery");
      delete state.inflight;
      if (!ok && !work.transition && state.attempts + 1 >= MAX_ATTEMPTS && !state.pending) {
        // A gate that is not going to open (push disabled, no partner key,
        // property not yet matched by Google) looks exactly like a network
        // failure here. After ~2h of backoff, stop: the six-hourly
        // reconciliation re-pushes anyway, and a per-property hourly alarm
        // forever is what this cap prevents. Explicit ON/OFF transitions are
        // never dropped — a lost block would leave a hotel for sale on Google.
        state.attempts = 0;
        console.log(`[google-ari] giving up on ${work.pid} after ${MAX_ATTEMPTS} attempts: ${results.map((r) => r.detail).join("; ")}`);
      } else if (!ok) {
        state.pending = state.pending ? mergeGoogleAriWork(work, state.pending) : work;
        state.attempts++;
      } else state.attempts = 0;
      await tx.put(STATE, state);
      if (state.pending) {
        const delay = ok || state.pending.revision > work.revision ? SOON_MS : Math.min(3_600_000, 5_000 * 2 ** Math.min(state.attempts - 1, 10));
        await tx.setAlarm(Date.now() + delay);
      } else await tx.deleteAlarm();
    });
    if (!ok) console.log(`[google-ari] retained failed delivery for ${work.pid}: ${results.map((r) => r.detail).join("; ")}`);
    return { revision: work.revision, results };
  }
}
