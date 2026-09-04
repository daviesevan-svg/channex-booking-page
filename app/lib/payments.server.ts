// Which payment gateway a property charges through. One property uses ONE
// gateway: Stripe (Connect Standard, platform-level secret + per-property
// account id in settings) or Viva (per-property credentials in their own KV
// key). Everything that used to test `settings.stripeAccountId &&
// config.stripeSecretKey` resolves through here instead, so Viva properties
// pass the same gates.
import { getConfig } from "./config.server";
import { getIyzicoConfig, getSettings, getVivaConfig } from "./overrides.server";
import type { SiteSettings } from "./content";
import type { VivaConfig } from "./viva.server";
import type { IyzicoConfig } from "./iyzico.server";

export type PaymentGateway =
  | { kind: "stripe"; account: string }
  | { kind: "viva"; viva: VivaConfig }
  | { kind: "iyzico"; iyzico: IyzicoConfig };

/** The gateway this property charges through, or null when none is set up.
 *  Stripe wins when both are somehow configured — the admin UI prevents that,
 *  but a stale Viva key must not silently divert charges. Pass `settings` when
 *  the caller already loaded them (saves the KV read). */
export async function activeGateway(pid: string, settings?: SiteSettings): Promise<PaymentGateway | null> {
  const s = settings ?? (await getSettings(pid));
  if (s.stripeAccountId && getConfig().stripeSecretKey) {
    return { kind: "stripe", account: s.stripeAccountId };
  }
  const viva = await getVivaConfig(pid);
  if (viva) return { kind: "viva", viva };
  const iyzico = await getIyzicoConfig(pid);
  return iyzico ? { kind: "iyzico", iyzico } : null;
}

/** Whether the gateway can hold a card on file without charging it (Stripe's
 *  setup mode). Neither Viva nor iyzico has an equivalent we use — a
 *  guarantee-card rate on either books without a card, like a property with no
 *  gateway at all. */
export function canSaveCard(gateway: PaymentGateway | null): boolean {
  return gateway?.kind === "stripe";
}
