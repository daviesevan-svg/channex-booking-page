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

/** True for an IP literal in a private / loopback / link-local / CGNAT range. */
function isPrivateIp(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
}

/** Reject webhook URLs that could target the internal network (SSRF): non-HTTPS,
 *  localhost, .internal/.local hostnames, or private/loopback/link-local IPs.
 *  DNS-rebinding to a private IP isn't fully preventable from a Worker, but
 *  dispatch also refuses to follow redirects (see dispatchWebhook). */
export function isSafeWebhookUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || /\.(local|internal|lan|home|corp)$/i.test(host)) return false;
  return !isPrivateIp(host);
}

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
  if (!isSafeWebhookUrl(url)) throw new Error("Unsafe webhook URL."); // backstop; route validates first
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
          redirect: "manual", // never follow a 3xx to an internal host (SSRF)
        });
        if (!res.ok) console.log(`[webhook] ${event} → ${ep.url} responded ${res.status}`);
      } catch (e) {
        console.log(`[webhook] ${event} → ${ep.url} failed: ${e instanceof Error ? e.message : e}`);
      }
    }),
  );
}
