// Google Travel Partner API — property match status.
// Lets us check whether Google has ingested/matched a property before we push
// rooms/rates/ARI to it. See docs/google-property-status.md.
//
// Auth is a service-account JWT (RS256) exchanged for an OAuth token — done by
// hand with WebCrypto since there's no googleapis SDK on Workers. Everything
// here is best-effort and fails soft (returns null) so a Travel Partner API
// hiccup can never stall the ARI push.
import { getConfig } from "../config.server";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/travelpartner";
const API = "https://travelpartner.googleapis.com/v3";

export interface GoogleMatchStatus {
  /** Google has matched the property to a listing (ready for ARI). */
  matched: boolean;
  /** Property is switched on for display on Google. */
  liveOnGoogle: boolean;
  /** Raw enum: MATCHED | NOT_MATCHED | MAP_OVERLAP | MATCH_STATUS_UNKNOWN | … */
  matchStatus: string;
  /** Why it isn't matched, when Google provides reasons. */
  reasons: string[];
}

// ---- base64url + PEM helpers ----
function b64url(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  // The JSON key stores the PEM with literal "\n"; turn those into real newlines.
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Cached access token (per isolate) until shortly before expiry.
let cached: { token: string; exp: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  const { googleTravelPartnerSaEmail: email, googleTravelPartnerSaKey: key } = getConfig();
  if (!email || !key) return null;
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;

  const signingInput =
    `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.` +
    b64url(JSON.stringify({ iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));

  let jwt: string;
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
    jwt = `${signingInput}.${b64url(sig)}`;
  } catch (e) {
    console.log(`[travelpartner] key import/sign failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }

  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
    });
    if (!res.ok) {
      console.log(`[travelpartner] token exchange ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;
    cached = { token: json.access_token, exp: now + (json.expires_in ?? 3600) };
    return cached.token;
  } catch (e) {
    console.log(`[travelpartner] token fetch failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

interface HotelView {
  partnerHotelId?: string;
  matchStatus?: string;
  liveOnGoogleStatus?: string;
  liveOnGoogle?: boolean;
  matchFailureReasons?: string[];
}

/** Match/live status for one property (its feed id = partnerHotelId), or null
 *  when we can't tell — not configured, token/API error, or no matching view.
 *  Callers must treat null as "unknown" and NOT block on it. */
export async function getGoogleMatchStatus(hotelId: string): Promise<GoogleMatchStatus | null> {
  const { googleTravelPartnerAccountId: acct } = getConfig();
  if (!acct || !hotelId) return null;
  const token = await getAccessToken();
  if (!token) return null;

  // Filter grammar per Google: `hotelId = 'VALUE'` (equals, spaces, quoted).
  const url =
    `${API}/accounts/${encodeURIComponent(acct)}/hotelViews` +
    `?pageSize=10&filter=${encodeURIComponent(`hotelId = '${hotelId}'`)}`;
  let json: { hotelViews?: HotelView[] };
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.log(`[travelpartner] hotelViews ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    json = (await res.json()) as { hotelViews?: HotelView[] };
  } catch (e) {
    console.log(`[travelpartner] hotelViews fetch failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }

  const views = json.hotelViews ?? [];
  // Match by partnerHotelId; if the filter didn't narrow it, fall back to the
  // first row. No row → null (unknown), never a hard "not matched".
  const view = views.find((v) => v.partnerHotelId === hotelId) ?? (views.length === 1 ? views[0] : undefined);
  if (!view) {
    // Success, but no matching view — tells us "not ingested / SA still
    // activating" (0 views) apart from a shape/filter surprise (>0 but no match).
    console.log(`[travelpartner] no matched view for ${hotelId} (${views.length} view(s) returned)`);
    return null;
  }

  return {
    matched: view.matchStatus === "MATCHED",
    liveOnGoogle: view.liveOnGoogleStatus === "LIVE_ON_GOOGLE_STATUS_ACTIVE" || view.liveOnGoogle === true,
    matchStatus: String(view.matchStatus ?? "MATCH_STATUS_UNKNOWN"),
    reasons: Array.isArray(view.matchFailureReasons) ? view.matchFailureReasons : [],
  };
}
