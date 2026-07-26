// The property's Channex credential.
//
// The hotelier pastes their personal `user-api-key` on /admin/rate-intel/settings.
// Unlike the onboard flow (key used once, then discarded), the price comparison
// needs to re-read the property's Booking.com room mapping whenever rooms or rate
// plans change, so the key IS kept — AES-GCM encrypted with a key derived from
// the session secret.
//
// Every use is read-only: listing the property's channels and reading the
// Booking.com one (see channex/bcom-mapping.server). Nothing here writes to
// Channex or to live inventory.
import { getConfig, getConfigKV } from "./config.server";
import { getChannexRoomCount, listChannexProperties } from "./channex/pms.server";

export interface RevmanState {
  /** AES-GCM ciphertext + iv of the Channex user-api-key, base64. */
  keyCipher: string;
  keyIv: string;
  /** The Channex property this maps to (usually = pid). */
  channexPropertyId: string;
  /** Room count read from Channex at connect time. Informational. */
  roomCount: number;
  connectedAt: string;
}

/** State without the key material — safe shape for loaders/UI. */
export type RevmanPublicState = Omit<RevmanState, "keyCipher" | "keyIv">;

const stateKey = (pid: string) => `revman:${pid}`;

async function aesKey(): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`revman:${getConfig().sessionSecret}`));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

const toB64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function encryptApiKey(plain: string): Promise<{ keyCipher: string; keyIv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), new TextEncoder().encode(plain));
  return { keyCipher: toB64(cipher), keyIv: toB64(iv) };
}

/** Throws if the ciphertext can't be decrypted (e.g. the session secret was
 *  rotated) — surfaced as an error state so the owner reconnects. */
async function decryptApiKey(state: RevmanState): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(state.keyIv) },
    await aesKey(),
    fromB64(state.keyCipher),
  );
  return new TextDecoder().decode(plain);
}

/** The property's Channex credentials for an OUTBOUND call: the decrypted
 *  user-api-key plus the Channex property id. Undefined when the property isn't
 *  connected; throws only if the stored key can't be decrypted. Kept here so the
 *  ciphertext never leaves this module. */
export async function getRevmanChannexAuth(
  pid: string,
): Promise<{ apiKey: string; channexPropertyId: string } | undefined> {
  const state = await readState(pid);
  if (!state) return undefined;
  return { apiKey: await decryptApiKey(state), channexPropertyId: state.channexPropertyId };
}

async function readState(pid: string): Promise<RevmanState | undefined> {
  const raw = await getConfigKV()?.get(stateKey(pid));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as RevmanState;
  } catch {
    return undefined;
  }
}

async function writeState(pid: string, state: RevmanState): Promise<void> {
  await getConfigKV()?.put(stateKey(pid), JSON.stringify(state));
}

export async function getRevmanState(pid: string): Promise<RevmanPublicState | undefined> {
  const s = await readState(pid);
  if (!s) return undefined;
  const { keyCipher: _c, keyIv: _i, ...pub } = s;
  return pub;
}

/** Forgets the key and the captured price comparison built on it. Reversible:
 *  the owner can paste the key again and re-capture. */
export async function disconnectRevman(pid: string): Promise<void> {
  await getConfigKV()?.delete(stateKey(pid));
  const { wipeCompSet } = await import("./revman-compset.server");
  await wipeCompSet(pid);
}

export interface RevmanConnectResult {
  /** Set when the key is valid but doesn't own `pid` — the UI shows a picker. */
  pickFrom?: { id: string; title: string }[];
}

/** Validates the key, resolves which Channex property this is (defaults to the
 *  local pid — they're the same id for onboarded properties), and stores the
 *  encrypted key. */
export async function connectRevman(
  pid: string,
  apiKey: string,
  channexPropertyId?: string,
): Promise<RevmanConnectResult> {
  const properties = await listChannexProperties(apiKey); // throws on bad key
  const targetId = channexPropertyId || pid;
  const target = properties.find((p) => p.id === targetId);
  if (!target) {
    return { pickFrom: properties.map((p) => ({ id: p.id, title: p.title })) };
  }
  const roomCount = await getChannexRoomCount(apiKey, target.id).catch(() => 0);
  await writeState(pid, {
    ...(await encryptApiKey(apiKey)),
    channexPropertyId: target.id,
    roomCount: Math.max(1, roomCount),
    connectedAt: new Date().toISOString(),
  });
  return {};
}
