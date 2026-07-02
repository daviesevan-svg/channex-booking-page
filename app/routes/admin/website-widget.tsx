import { useState } from "react";

import type { Route } from "./+types/website-widget";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, isOwnerOrSuper } from "~/lib/properties.server";
import { getConfig } from "~/lib/config.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const canManage = await isOwnerOrSuper(request, propertyId);
  // The public origin guests reach the widget from.
  const appUrl = getConfig().appUrl.replace(/\/+$/, "");
  return { configured: true as const, canManage, propertyId, appUrl };
}

export function meta() {
  return [{ title: "Admin · Website widget" }];
}

export default function WebsiteWidget({ loaderData }: Route.ComponentProps) {
  const [copied, setCopied] = useState(false);
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

  const { propertyId, appUrl } = loaderData;
  const snippet = `<script async src="${appUrl}/embed.js" data-property="${propertyId}"></script>`;
  const previewSrc = `${appUrl}/embed/${propertyId}`;

  return (
    <div className="space-y-6">
      <h1 className="font-serif text-[26px] font-semibold">Website widget</h1>
      <p className="max-w-2xl text-[14px] text-secondary">
        Add a date-picker to your own website that sends guests straight into your commission-free
        booking pages. Paste this one line where you want it to appear — it matches your booking
        engine's theme automatically.
      </p>

      <section className="rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-3 font-serif text-[18px] font-semibold">Embed code</h2>
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-3 font-mono text-[13px] text-ink">
            {snippet}
          </code>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(snippet).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                },
                () => {},
              );
            }}
            className="flex-none rounded-[10px] border border-line-alt bg-surface px-4 py-3 text-[13px] font-semibold text-secondary hover:border-accent hover:text-accent"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="mt-2.5 text-[12.5px] text-muted">
          Optional: add <code className="font-mono">data-target="my-div-id"</code> to render inside a
          specific element, or <code className="font-mono">data-height="180"</code> to set the initial
          height. The widget resizes itself to fit.
        </p>
      </section>

      <section className="rounded-[14px] border border-line bg-surface p-6">
        <h2 className="mb-1 font-serif text-[18px] font-semibold">Live preview</h2>
        <p className="mb-4 text-[13.5px] text-muted">Exactly what visitors see on your site.</p>
        <iframe
          title="Widget preview"
          src={previewSrc}
          className="w-full rounded-[12px] border border-line-alt"
          style={{ height: 160 }}
        />
      </section>
    </div>
  );
}
