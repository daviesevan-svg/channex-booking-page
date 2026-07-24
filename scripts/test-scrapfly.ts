// Standalone connectivity test for Scrapfly — run BEFORE building the comp-set
// pipeline, to confirm the key works and we actually get OTA results back.
//
//   npx tsx scripts/test-scrapfly.ts ["<target url>"]
//
// Reads SCRAPFLY_API_KEY from .dev.vars (gitignored) or the environment. This
// script talks to Scrapfly's HTTP API directly (it does NOT import the app,
// which needs the Workers runtime) — it validates the vendor + key + that the
// target page is retrievable, nothing more. The key is never printed.
import { readFileSync } from "node:fs";

function loadKey(): string {
  if (process.env.SCRAPFLY_API_KEY) return process.env.SCRAPFLY_API_KEY;
  try {
    const vars = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
    const line = vars.split(/\r?\n/).find((l) => l.trim().startsWith("SCRAPFLY_API_KEY="));
    if (line) return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  } catch {
    /* no .dev.vars */
  }
  throw new Error("SCRAPFLY_API_KEY not found in env or .dev.vars");
}

// Default target: a Booking.com search for Carmarthen (Spilman's town) — the
// kind of region page comp-set discovery will parse. Override with argv[2].
const DEFAULT_TARGET =
  "https://www.booking.com/searchresults.html?ss=Carmarthen%2C+Wales%2C+United+Kingdom&group_adults=2&no_rooms=1&group_children=0";

async function main() {
  const key = loadKey();
  const target = process.argv[2] || DEFAULT_TARGET;
  console.log(`Key: ${key.slice(0, 7)}…${key.slice(-3)} (len ${key.length})`);
  console.log(`Target: ${target}\n`);

  const params = new URLSearchParams({
    key,
    url: target,
    asp: "true",
    render_js: "true",
    country: "gb",
    proxy_pool: "public_residential_pool",
    retry: "true",
    format: "raw",
  });

  const t0 = Date.now();
  const res = await fetch(`https://api.scrapfly.io/scrape?${params.toString()}`);
  const body: any = await res.json().catch(() => null);
  const ms = Date.now() - t0;

  console.log(`Scrapfly HTTP: ${res.status} (${ms}ms)`);
  if (!body) return console.log("No JSON body.");
  const r = body.result ?? {};
  console.log(`result.success: ${r.success}`);
  console.log(`upstream status_code: ${r.status_code}`);
  console.log(`credit cost: ${body.context?.cost?.total ?? "?"}`);
  if (body.message || r.error) console.log(`message: ${body.message ?? r.error?.message}`);

  const html: string = typeof r.content === "string" ? r.content : "";
  console.log(`content length: ${html.length}`);

  // Cheap signal that we got a real Booking.com results page (not a block page):
  // count property-card title nodes. This regex is intentionally loose — parsing
  // is the next step, this only answers "did we get results?".
  const titles = [...html.matchAll(/data-testid=["']title["'][^>]*>([^<]{2,80})</g)].map((m) => m[1].trim());
  const blocked = /captcha|are you a robot|access denied|unusual traffic/i.test(html);
  console.log(`blocked-page signals: ${blocked ? "YES ⚠️" : "none"}`);
  console.log(`hotel-title matches: ${titles.length}`);
  console.log(titles.slice(0, 10).map((t, i) => `  ${i + 1}. ${t}`).join("\n"));
}

main().catch((e) => {
  console.error("FAILED:", e.message ?? e);
  process.exit(1);
});
