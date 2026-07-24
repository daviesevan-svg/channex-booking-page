// Scrapfly web-scraping client. Scrapfly is a commercial scraping vendor: we
// call their documented HTTP API and they own the retrieval + anti-bot posture
// under their own terms. From our side this is just a data API — same shape as
// any other vendor integration. Used for competitor-set discovery and (later)
// per-day price capture from OTA pages.
//
// API: GET https://api.scrapfly.io/scrape?key=…&url=…  (url must be encoded).
// Response is JSON; the fetched page is at result.content, and Scrapfly reports
// the upstream fetch under result.status_code with result.success.
import { getConfig } from "./config.server";

const SCRAPE_ENDPOINT = "https://api.scrapfly.io/scrape";

export interface ScrapeOptions {
  /** Enable Scrapfly's Anti Scraping Protection (needed for OTA pages). */
  asp?: boolean;
  /** Render JavaScript before returning HTML. */
  renderJs?: boolean;
  /** Proxy country (ISO 3166-1 alpha-2), e.g. "gb". Aligns prices to a market. */
  country?: string;
  /** Proxy pool. Residential is stealthier (and pricier) than datacenter. */
  proxyPool?: "public_datacenter_pool" | "public_residential_pool";
  /** Let Scrapfly retry transient upstream failures. Default true. */
  retry?: boolean;
  /** Output format Scrapfly returns in result.content. Default "raw" (HTML). */
  format?: "raw" | "clean_html" | "text" | "markdown" | "json";
  /** Abort the request after this many ms (Scrapfly can be slow with render_js). */
  timeoutMs?: number;
}

export interface ScrapeResult {
  /** True when Scrapfly successfully fetched the upstream page. */
  ok: boolean;
  /** Upstream HTTP status Scrapfly saw fetching the target. */
  upstreamStatus: number | null;
  /** The fetched page body (HTML/text/markdown per `format`). */
  content: string;
  /** Scrapfly credit cost of this call, from the response (billing visibility). */
  cost: number | null;
  /** The resolved final URL Scrapfly fetched (after redirects). */
  url: string | null;
  /** Populated when the call failed before/through Scrapfly (not an upstream 4xx). */
  error?: string;
}

export function isScrapflyConfigured(): boolean {
  return Boolean(getConfig().scrapflyApiKey);
}

/** Low-level: fetch one URL through Scrapfly. Never throws — returns a result
 *  with `ok:false` + `error` on any failure, so callers can degrade gracefully.
 *  The API key is read from config (secret) and never logged. */
export async function scrapeUrl(target: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
  const key = getConfig().scrapflyApiKey;
  if (!key) return { ok: false, upstreamStatus: null, content: "", cost: null, url: null, error: "Scrapfly API key not configured." };

  const params = new URLSearchParams({ key, url: target });
  if (opts.asp ?? true) params.set("asp", "true");
  if (opts.renderJs) params.set("render_js", "true");
  if (opts.country) params.set("country", opts.country);
  if (opts.proxyPool) params.set("proxy_pool", opts.proxyPool);
  params.set("retry", String(opts.retry ?? true));
  if (opts.format) params.set("format", opts.format);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(`${SCRAPE_ENDPOINT}?${params.toString()}`, { signal: ctrl.signal });
    const body = (await res.json().catch(() => null)) as ScrapflyEnvelope | null;
    if (!res.ok || !body) {
      // Scrapfly-level error (bad key, quota, plan limits) — message is safe to
      // surface; it never contains the key.
      const msg = body?.result?.error?.message || body?.message || `Scrapfly HTTP ${res.status}`;
      return { ok: false, upstreamStatus: null, content: "", cost: null, url: null, error: msg };
    }
    const r = body.result;
    return {
      ok: Boolean(r?.success),
      upstreamStatus: typeof r?.status_code === "number" ? r.status_code : null,
      content: typeof r?.content === "string" ? r.content : "",
      cost: typeof body.context?.cost?.total === "number" ? body.context.cost.total : null,
      url: r?.url ?? null,
      error: r?.success ? undefined : r?.error?.message || `Upstream status ${r?.status_code ?? "?"}`,
    };
  } catch (err) {
    const msg = err instanceof Error && err.name === "AbortError" ? "Scrapfly request timed out." : String(err);
    return { ok: false, upstreamStatus: null, content: "", cost: null, url: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// Minimal shape of the parts of the Scrapfly response we read. Scrapfly returns
// much more (headers, screenshots, browser data); we only need content + status.
interface ScrapflyEnvelope {
  message?: string;
  result?: {
    success?: boolean;
    status_code?: number;
    content?: string;
    url?: string;
    error?: { message?: string } | null;
  };
  context?: { cost?: { total?: number } };
}
