import { getConfigKV } from "./config.server";
import { computeDiscount, normalizeCode, type AppliedPromo, type Promotion } from "./promotions";

const promotionsKey = (pid: string) => `promotions:${pid}`;

export async function getPromotions(pid: string): Promise<Promotion[]> {
  const kv = getConfigKV();
  if (!kv) return [];
  const raw = await kv.get(promotionsKey(pid));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as Promotion[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function getPromotion(pid: string, id: string): Promise<Promotion | undefined> {
  return (await getPromotions(pid)).find((p) => p.id === id);
}

/** The enabled promotion matching a guest-entered code, if any. */
export async function findPromotionByCode(
  pid: string,
  code: string,
): Promise<Promotion | undefined> {
  const c = normalizeCode(code);
  if (!c) return undefined;
  return (await getPromotions(pid)).find((p) => p.enabled && p.code === c);
}

/** Resolve a guest-entered code against a booking total. Returns the applied
 *  discount, or null when the code is blank, unknown, disabled, or zero-value. */
export async function resolveAppliedPromo(
  pid: string,
  code: string,
  total: number,
): Promise<AppliedPromo | null> {
  const promo = await findPromotionByCode(pid, code);
  if (!promo) return null;
  const discount = computeDiscount(promo, total);
  if (discount <= 0) return null;
  return { code: promo.code, type: promo.type, value: promo.value, discount };
}

async function writePromotions(pid: string, list: Promotion[]): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(promotionsKey(pid), JSON.stringify(list));
}

/** Insert or update a promotion (matched by id). Returns the saved record. */
export async function savePromotion(pid: string, promo: Promotion): Promise<Promotion> {
  const list = await getPromotions(pid);
  const i = list.findIndex((p) => p.id === promo.id);
  if (i === -1) list.unshift(promo);
  else list[i] = promo;
  await writePromotions(pid, list);
  return promo;
}

export async function deletePromotion(pid: string, id: string): Promise<void> {
  const list = await getPromotions(pid);
  const next = list.filter((p) => p.id !== id);
  if (next.length !== list.length) await writePromotions(pid, next);
}

export async function togglePromotion(pid: string, id: string): Promise<void> {
  const list = await getPromotions(pid);
  const p = list.find((x) => x.id === id);
  if (!p) return;
  p.enabled = !p.enabled;
  await writePromotions(pid, list);
}
