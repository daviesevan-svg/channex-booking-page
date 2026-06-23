import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/home";
import { requireAdmin } from "~/lib/auth.server";
import { getChannexClient, getConfig } from "~/lib/config.server";
import { DEFAULT_SEARCH, langParam, pickLang, type SearchContent } from "~/lib/content";
import { getSearchContentRaw, saveSearchContent } from "~/lib/overrides.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) return { configured: false as const };

  const lang = langParam(request);
  const property = await getChannexClient().getPropertyInfo(propertyId).catch(() => null);
  const content = await getSearchContentRaw(propertyId, lang);
  const eyebrowDefault = (property?.address?.split(",")[1] ?? property?.title ?? "").trim();
  return { configured: true as const, content, eyebrowDefault, lang };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };

  const form = await request.formData();
  const s = (v: FormDataEntryValue | null) => String(v ?? "").trim();
  const titles = form.getAll("highlightTitle").map(String);
  const descs = form.getAll("highlightDesc").map(String);
  // Keep only rows the editor actually filled in; empty => fall back to the
  // language defaults rather than baking in English.
  const highlights = [0, 1, 2]
    .map((i) => ({ title: (titles[i] ?? "").trim(), description: (descs[i] ?? "").trim() }))
    .filter((h) => h.title || h.description);

  const content: SearchContent = {
    eyebrow: s(form.get("eyebrow")) || undefined,
    heading: s(form.get("heading")) || undefined,
    intro: s(form.get("intro")) || undefined,
    promoText: s(form.get("promoText")) || undefined,
    searchButton: s(form.get("searchButton")) || undefined,
    highlights: highlights.length ? highlights : undefined,
  };
  await saveSearchContent(propertyId, pickLang(s(form.get("lang"))), content);
  return { ok: true };
}

export function meta() {
  return [{ title: "Admin · Home page" }];
}

const inputCls =
  "mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[11px] text-[15px] text-ink outline-none focus:border-accent";

function Field({
  name,
  label,
  value,
  placeholder,
  textarea,
}: {
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
  textarea?: boolean;
}) {
  return (
    <label className="block text-[13px] font-semibold text-secondary">
      {label}
      {textarea ? (
        <textarea name={name} rows={3} defaultValue={value} placeholder={placeholder} className={`${inputCls} resize-y`} />
      ) : (
        <input name={name} defaultValue={value} placeholder={placeholder} className={inputCls} />
      )}
    </label>
  );
}

export default function AdminHome({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Home page</h1>
        <p className="text-[15px] text-secondary">
          Set <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code> to edit page
          content.
        </p>
      </div>
    );
  }

  const { content, eyebrowDefault, lang } = loaderData;

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">Home page</h1>
        {actionData?.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            ✓ Saved
          </span>
        )}
      </div>
      <p className="mb-6 text-[14px] text-muted">
        The text guests see on the landing page. Empty fields use the defaults shown.
      </p>

      <Form
        method="post"
        key={lang}
        className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6"
      >
        <input type="hidden" name="lang" value={lang} />
        <Field name="eyebrow" label="Eyebrow (small label above the heading)" value={content.eyebrow} placeholder={eyebrowDefault} />
        <Field name="heading" label="Heading" value={content.heading} placeholder={DEFAULT_SEARCH.heading} />
        <Field name="intro" label="Intro paragraph" value={content.intro} placeholder={DEFAULT_SEARCH.intro} textarea />
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field name="searchButton" label="Search button label" value={content.searchButton} placeholder={DEFAULT_SEARCH.searchButton} />
          <Field name="promoText" label="Promo link text" value={content.promoText} placeholder={DEFAULT_SEARCH.promoText} />
        </div>

        <div className="border-t border-divider pt-5">
          <div className="mb-3 font-serif text-[18px] font-semibold">Highlights</div>
          <div className="flex flex-col gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1.6fr]">
                <label className="block text-[13px] font-semibold text-secondary">
                  Highlight {i + 1} title
                  <input
                    name="highlightTitle"
                    defaultValue={content.highlights?.[i]?.title}
                    placeholder={DEFAULT_SEARCH.highlights[i].title}
                    className={inputCls}
                  />
                </label>
                <label className="block text-[13px] font-semibold text-secondary">
                  Description
                  <input
                    name="highlightDesc"
                    defaultValue={content.highlights?.[i]?.description}
                    placeholder={DEFAULT_SEARCH.highlights[i].description}
                    className={inputCls}
                  />
                </label>
              </div>
            ))}
          </div>
        </div>

        {actionData?.error && <p className="text-[13px] text-red-600">{actionData.error}</p>}
        <div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </Form>
    </div>
  );
}
