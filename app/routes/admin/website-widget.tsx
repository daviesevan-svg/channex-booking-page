import { useRef, useState } from "react";
import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/website-widget";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, getProperty, isOwnerOrSuper } from "~/lib/properties.server";
import { getConfig } from "~/lib/config.server";
import { getSettings, saveThemeTokens } from "~/lib/overrides.server";
import { FONT_PAIRS, fontPair } from "~/lib/content";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const canManage = await isOwnerOrSuper(request, propertyId);
  const settings = await getSettings(propertyId);
  const appUrl = getConfig().appUrl.replace(/\/+$/, "");
  // Prefer the shortcode in the snippet/links when one is set (it resolves to the
  // same property); fall back to the id.
  const linkId = (await getProperty(propertyId))?.slug || propertyId;
  return {
    configured: true as const,
    canManage,
    propertyId,
    linkId,
    appUrl,
    accent: settings.theme === "custom" ? settings.customColor ?? null : null,
    themeName: settings.theme ?? "terracotta",
    fontLabel: fontPair(settings.themeFont).label,
    // Versions the preview iframe so it reloads when the theme changes.
    themeVersion: `${settings.customColor ?? settings.theme ?? ""}-${settings.themeFont ?? ""}-${settings.customBg ?? ""}`,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "Add a property first." };
  if (!(await isOwnerOrSuper(request, propertyId))) {
    return { error: "Only an owner or manager can theme the widget." };
  }
  const form = await request.formData();
  // Be tolerant of a pasted ```json fence.
  const raw = String(form.get("themeJson") ?? "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  if (!raw) return { error: "Paste the theme JSON the AI returned." };
  let parsed: { accent?: unknown; background?: unknown; bg?: unknown; font?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "That isn't valid JSON — paste exactly what the AI returned (starting with {)." };
  }
  if (!parsed || typeof parsed !== "object") return { error: "The theme must be a JSON object." };
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  // saveThemeTokens ignores any invalid field, so a partial/bad paste can't wipe the theme.
  await saveThemeTokens(propertyId, { accent: str(parsed.accent), bg: str(parsed.background) ?? str(parsed.bg), font: str(parsed.font) });
  return { applied: true as const };
}

export function meta() {
  return [{ title: "Admin · Website widget" }];
}

export default function WebsiteWidget({ loaderData, actionData }: Route.ComponentProps) {
  const [copied, setCopied] = useState(false);
  const [briefCopied, setBriefCopied] = useState(false);
  const [devCopied, setDevCopied] = useState(false);
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const techRef = useRef<HTMLInputElement>(null);
  const nav = useNavigation();

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Website widget</h1>
        <p className="text-[15px] text-secondary">Add a property first.</p>
      </div>
    );
  }
  if (!loaderData.canManage) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Website widget</h1>
        <p className="text-[15px] text-secondary">Only an owner or manager can manage the widget.</p>
      </div>
    );
  }

  const { linkId, appUrl, accent, themeName, fontLabel, themeVersion } = loaderData;
  const snippet = `<script async src="${appUrl}/embed.js" data-property="${linkId}"></script>`;
  const previewSrc = `${appUrl}/embed/${linkId}?v=${encodeURIComponent(themeVersion)}`;
  const input = "rounded-[10px] border border-line-alt bg-surface px-3 py-2 text-[14px] outline-none focus:border-accent";

  const copyBrief = async () => {
    const brand = (briefRef.current?.value ?? "").trim();
    const fontList = FONT_PAIRS.map((f) => `  "${f.id}" — ${f.label}`).join("\n");
    const brief = [
      `You are theming a hotel's online booking widget. Produce a colour + font theme that matches this brand:`,
      ``,
      brand || "(describe your brand: name, feel, existing website colours, personality)",
      ``,
      `Return ONLY a JSON object (no prose, no code fence) with exactly these keys:`,
      `{`,
      `  "accent": "#RRGGBB",      // primary brand / call-to-action colour`,
      `  "background": "#RRGGBB",  // very light page tint (near-white), NOT the accent`,
      `  "font": "<one id from the list below>"`,
      `}`,
      ``,
      `Rules:`,
      `- accent: vivid and legible — white button text must be readable on it.`,
      `- background: a subtle near-white tint, never dark.`,
      `- font: MUST be exactly one of these ids, chosen to fit the brand's personality:`,
      fontList,
      `- Output valid JSON only.`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(brief);
      setBriefCopied(true);
      setTimeout(() => setBriefCopied(false), 1800);
    } catch {
      /* clipboard blocked */
    }
  };

  const deepLink = `${appUrl}/${linkId}/rooms?checkin=YYYY-MM-DD&checkout=YYYY-MM-DD&adults=2&childrenAge=8,12`;
  const copyDevBrief = async () => {
    const brand = (briefRef.current?.value ?? "").trim();
    const tech = (techRef.current?.value ?? "").trim();
    const brief = [
      `Build a booking date-picker widget for my hotel's website.`,
      ``,
      `Website tech: ${tech || "plain HTML/CSS/JS (no framework)"}`,
      `Brand / style: ${brand || "match my existing website"}`,
      ``,
      `When the guest picks their dates + guests and clicks the button, send the browser to this URL`,
      `(fill in the values):`,
      ``,
      `  ${deepLink}`,
      ``,
      `URL rules:`,
      `- checkin, checkout: dates formatted YYYY-MM-DD. checkout must be after checkin, and checkin must be today or later.`,
      `- adults: whole number, at least 1 (default 2).`,
      `- childrenAge: OPTIONAL, comma-separated age of each child (0–17), e.g. 8,12. Omit entirely if none.`,
      `- Do NOT add price or currency params — the booking page handles pricing and availability.`,
      ``,
      `Widget requirements:`,
      `- A date-range picker: block past dates and any checkout on/before checkin.`,
      `- A guests control: adults (min 1) plus optional children, each with an age.`,
      `- A "Check availability" button that builds the URL above and does window.location.href = url`,
      `  (if you place the widget in an iframe, navigate the TOP window instead).`,
      `- Style it to match the brand above — you have full freedom over layout, fonts, colours, corner`,
      `  radius, spacing and wording.`,
      `- Fully self-contained: no API keys and no server calls — it only builds and opens a link.`,
      ``,
      `Return the complete, ready-to-paste widget code.`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(brief);
      setDevCopied(true);
      setTimeout(() => setDevCopied(false), 1800);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="font-serif text-[26px] font-semibold">Website widget</h1>
      <p className="max-w-2xl text-[14px] text-secondary">
        Add a date-picker to your own website that sends guests straight into your commission-free
        booking pages. It matches your booking engine's theme automatically.
      </p>

      {actionData && "error" in actionData && actionData.error && (
        <p className="rounded-[10px] border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-700">{actionData.error}</p>
      )}
      {actionData && "applied" in actionData && actionData.applied && (
        <p className="rounded-[10px] border border-[#cfe3cf] bg-[#f2f8f1] px-4 py-2.5 text-[13px] text-[#3f7a52]">✓ Theme applied — preview updated below.</p>
      )}

      {/* Embed code */}
      <section className="rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-3 font-serif text-[18px] font-semibold">Embed code</h2>
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-3 font-mono text-[13px] text-ink">
            {snippet}
          </code>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(snippet).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }, () => {});
            }}
            className="flex-none rounded-[10px] border border-line-alt bg-surface px-4 py-3 text-[13px] font-semibold text-secondary hover:border-accent hover:text-accent"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="mt-2.5 text-[12.5px] text-muted">
          Optional: <code className="font-mono">data-target="my-div-id"</code> to render inside a specific element,
          or <code className="font-mono">data-height="180"</code> for the initial height. It resizes itself to fit.
        </p>
      </section>

      {/* AI branding */}
      <section className="rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-1 font-serif text-[18px] font-semibold">Theme it with AI</h2>
        <p className="mb-4 max-w-2xl text-[13.5px] text-muted">
          Describe your brand, copy the ready-made prompt into ChatGPT or Claude, then paste the result
          back here. No fiddling with colour pickers — the theme applies to your widget <em>and</em> your
          booking pages.
        </p>

        <div className="mb-4 flex flex-wrap items-center gap-3 text-[13px]">
          <span className="text-secondary">Current theme:</span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line-alt px-2.5 py-1 font-semibold">
            <span className="h-3.5 w-3.5 rounded-full border border-line-alt" style={{ background: accent || "var(--accent)" }} />
            {accent ? accent : `preset · ${themeName}`}
          </span>
          <span className="rounded-full border border-line-alt px-2.5 py-1 font-semibold">{fontLabel}</span>
        </div>

        <label className="mb-1.5 block text-[13px] font-semibold text-secondary">Your brand</label>
        <textarea
          ref={briefRef}
          rows={3}
          placeholder="e.g. Coastal boutique hotel — calm, elegant, sandy neutrals with a deep navy accent; classic serif headings."
          className={`${input} mb-2 w-full`}
        />
        <button
          type="button"
          onClick={copyBrief}
          className="rounded-[10px] border border-line-alt bg-surface px-4 py-2.5 text-[13px] font-semibold text-secondary hover:border-accent hover:text-accent"
        >
          {briefCopied ? "Copied brief ✓" : "Copy AI brief"}
        </button>

        <Form method="post" className="mt-5">
          <label className="mb-1.5 block text-[13px] font-semibold text-secondary">Paste the AI's theme JSON</label>
          <textarea
            name="themeJson"
            rows={4}
            placeholder={`{\n  "accent": "#123456",\n  "background": "#f6f8fb",\n  "font": "playfair-inter"\n}`}
            className={`${input} w-full font-mono text-[13px]`}
          />
          <button
            type="submit"
            disabled={nav.state !== "idle"}
            className="mt-2 rounded-[10px] bg-accent px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            Apply theme
          </button>
        </Form>
      </section>

      {/* Build a fully custom widget (advanced) */}
      <section className="rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-1 font-serif text-[18px] font-semibold">Build a fully custom widget</h2>
        <p className="mb-4 max-w-2xl text-[13.5px] text-muted">
          Want total control over the design — corners, layout, wording, your own framework? Copy this
          brief into ChatGPT or Claude and it'll build a bespoke widget from scratch. It just needs the
          deep-link below; the booking page handles availability and pricing.
        </p>

        <label className="mb-1.5 block text-[13px] font-semibold text-secondary">Your website tech (optional)</label>
        <input
          ref={techRef}
          placeholder="e.g. WordPress, Squarespace, React, plain HTML"
          className={`${input} mb-3 w-full max-w-sm`}
        />

        <div className="mb-1.5 text-[13px] font-semibold text-secondary">Booking deep-link for this property</div>
        <code className="mb-3 block whitespace-pre-wrap break-all rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-3 font-mono text-[12.5px] text-ink">
          {deepLink}
        </code>

        <button
          type="button"
          onClick={copyDevBrief}
          className="rounded-[10px] border border-line-alt bg-surface px-4 py-2.5 text-[13px] font-semibold text-secondary hover:border-accent hover:text-accent"
        >
          {devCopied ? "Copied brief ✓" : "Copy developer brief"}
        </button>
        <p className="mt-2.5 text-[12.5px] text-muted">
          The brief reuses the brand description above. Uses the same date/guest params as the standard
          widget, so anything built this way drops straight into your booking flow.
        </p>
      </section>

      {/* Live preview */}
      <section className="rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-1 font-serif text-[18px] font-semibold">Live preview</h2>
        <p className="mb-4 text-[13.5px] text-muted">Exactly what visitors see on your site.</p>
        <iframe
          key={themeVersion}
          title="Widget preview"
          src={previewSrc}
          className="w-full rounded-[12px] border border-line-alt"
          style={{ height: 160 }}
        />
      </section>
    </div>
  );
}
