import { useState } from "react";

import type { Route } from "./+types/brand-kit";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { buildBrandKit } from "~/lib/brand-kit.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const kit = await buildBrandKit(propertyId);
  return { configured: true as const, ...kit };
}

export function meta() {
  return [{ title: "Admin · Brand kit" }];
}

function Swatch({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="h-8 w-8 flex-none rounded-[8px] border border-line-alt" style={{ background: value }} />
      <span className="min-w-0">
        <span className="block text-[12px] font-semibold text-secondary">{label}</span>
        <span className="block truncate font-mono text-[11px] text-muted">{value}</span>
      </span>
    </div>
  );
}

export default function BrandKit({ loaderData }: Route.ComponentProps) {
  const [copied, setCopied] = useState(false);

  if (!loaderData.configured) {
    return (
      <div>
        <h1 className="mb-1 font-serif text-[26px] font-semibold">Brand kit</h1>
        <p className="text-[14px] text-muted">Add a property first to generate its brand kit.</p>
      </div>
    );
  }

  const { hotelName, tokens, css, json, prompt } = loaderData;

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the prompt is visible below to copy manually */
    }
  };

  const download = (filename: string, contents: string, type: string) => {
    const url = URL.createObjectURL(new Blob([contents], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const btn =
    "rounded-[10px] border border-line-alt bg-surface px-4 py-2.5 text-[13px] font-semibold text-secondary hover:border-accent hover:text-accent";

  return (
    <div className="max-w-[760px]">
      <h1 className="mb-1 font-serif text-[26px] font-semibold">Brand kit</h1>
      <p className="mb-6 max-w-[640px] text-[14px] text-muted">
        Building a new website for <strong>{hotelName}</strong>? This pack captures the exact colours,
        fonts and shapes your booking pages use, so a designer — or an AI like ChatGPT or Claude — can
        make a site that matches. Copy the prompt, or download the token files to drop straight in.
      </p>

      {/* Token preview */}
      <section className="mb-5 rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-4 font-serif text-[18px] font-semibold">Your style</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Swatch label="Accent" value={tokens.accent} />
          <Swatch label="Accent (hover)" value={tokens.accentDeep} />
          <Swatch label="Page" value={tokens.page} />
          <Swatch label="Text" value={tokens.neutrals.ink} />
          <Swatch label="Surface" value={tokens.neutrals.surface} />
          <Swatch label="Border" value={tokens.neutrals.line} />
        </div>
        <div className="mt-4 border-t border-divider pt-4 text-[13px]">
          <div className="text-secondary">
            <span className="font-semibold">Headings:</span>{" "}
            <span style={{ fontFamily: tokens.fonts.heading }}>{tokens.fonts.heading.split(",")[0].replace(/"/g, "")}</span>
          </div>
          <div className="mt-1 text-secondary">
            <span className="font-semibold">Body:</span>{" "}
            <span style={{ fontFamily: tokens.fonts.body }}>{tokens.fonts.body.split(",")[0].replace(/"/g, "")}</span>
          </div>
        </div>
      </section>

      {/* AI prompt */}
      <section className="mb-5 rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-1 font-serif text-[18px] font-semibold">Build it with AI</h2>
        <p className="mb-4 max-w-2xl text-[13.5px] text-muted">
          Copy this prompt into ChatGPT, Claude, or a tool like v0 or Lovable. It contains your exact
          tokens, so whatever it builds will match your booking pages.
        </p>
        <textarea
          readOnly
          value={prompt}
          rows={10}
          className="mb-3 w-full rounded-[10px] border border-line-alt bg-surface-alt p-3 font-mono text-[12px] text-secondary"
        />
        <button type="button" onClick={copyPrompt} className={btn}>
          {copied ? "Copied prompt ✓" : "Copy AI prompt"}
        </button>
      </section>

      {/* Downloads */}
      <section className="rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-1 font-serif text-[18px] font-semibold">Token files</h2>
        <p className="mb-4 max-w-2xl text-[13.5px] text-muted">
          For a developer: <code className="font-mono">brand.css</code> is a drop-in stylesheet (fonts +
          CSS variables + a few base styles); <code className="font-mono">tokens.json</code> is the same
          values as data (handy for Tailwind or design tools).
        </p>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => download("brand.css", css, "text/css")} className={btn}>
            Download brand.css
          </button>
          <button
            type="button"
            onClick={() => download("tokens.json", json, "application/json")}
            className={btn}
          >
            Download tokens.json
          </button>
        </div>
      </section>
    </div>
  );
}
