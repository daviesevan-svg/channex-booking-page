// Outbound webhooks: per-property endpoint subscriptions + signed delivery.
// Each delivery is signed `Roompanda-Signature: t=<unix>,v1=<hex>` where
// hex = HMAC-SHA256(secret, "<t>.<body>") — mirrors Stripe so consumers verify
// the same way. Delivery is best-effort (logged on failure); a durable retry
// queue is a later enhancement (no Queues/Durable Objects yet).
import { getConfigKV } from "./config.server";
import { hmacSha256Hex } from "./hmac.server";
import { WEBHOOK_EVENTS, type WebhookEvent } from "./webhook-events";

export { WEBHOOK_EVENTS, type WebhookEvent };

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
  disabled?: boolean;
  createdAt: string;
}

const key = (pid: string) => `webhooks:${pid}`;

async function readJson<T>(k: string): Promise<T | null> {
  const kv = getConfigKV();
  if (!kv) return null;
  const raw = await kv.get(k);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
async function writeJson(k: string, v: unknown): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(k, JSON.stringify(v));
}

function rand(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function listWebhooks(pid: string): Promise<WebhookEndpoint[]> {
  return (await readJson<WebhookEndpoint[]>(key(pid))) ?? [];
}

export async function addWebhook(pid: string, url: string, events: WebhookEvent[]): Promise<WebhookEndpoint> {
  const eps = await listWebhooks(pid);
  const ep: WebhookEndpoint = {
    id: rand(8),
    url: url.trim(),
    secret: `whsec_${rand(24)}`,
    events: events.length ? events : [...WEBHOOK_EVENTS],
    createdAt: new Date().toISOString(),
  };
  eps.push(ep);
  await writeJson(key(pid), eps);
  return ep;
}

export async function removeWebhook(pid: string, id: string): Promise<void> {
  await writeJson(key(pid), (await listWebhooks(pid)).filter((e) => e.id !== id));
}

/** Deliver an event to every enabled endpoint subscribed to it. Best-effort:
 *  failures are logged, never thrown (a webhook must not break a booking). */
export async function dispatchWebhook(pid: string, event: WebhookEvent, data: unknown, nowMs: number): Promise<void> {
  const eps = (await listWebhooks(pid)).filter((e) => !e.disabled && e.events.includes(event));
  if (!eps.length) return;
  const t = Math.floor(nowMs / 1000);
  const body = JSON.stringify({ id: `evt_${rand(12)}`, type: event, created: t, data });
  await Promise.all(
    eps.map(async (ep) => {
      try {
        const sig = await hmacSha256Hex(ep.secret, `${t}.${body}`);
        const res = await fetch(ep.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Roompanda-Signature": `t=${t},v1=${sig}` },
          body,
        });
        if (!res.ok) console.log(`[webhook] ${event} → ${ep.url} responded ${res.status}`);
      } catch (e) {
        console.log(`[webhook] ${event} → ${ep.url} failed: ${e instanceof Error ? e.message : e}`);
      }
    }),
  );
}
