import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/collection";
import { FIELD_INPUT } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import {
  deleteCollection,
  getVisibleCollections,
  updateCollection,
} from "~/lib/collections.server";
import { getConfig } from "~/lib/config.server";
import { FONT_PAIRS, isThemeId, THEMES } from "~/lib/content";
import { getVisibleProperties } from "~/lib/properties.server";
import { getOverrides, getSettings } from "~/lib/overrides.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const collection = (await getVisibleCollections(request)).find((c) => c.slug === params.slug);
  if (!collection) throw redirect("/admin/collections");

  // The properties this user can add to the collection, with the name + whether
  // each has map coordinates (needed for the map pins on the public page).
  const props = await getVisibleProperties(request);
  const properties = await Promise.all(
    props.map(async (p) => {
      const [ov, settings] = await Promise.all([getOverrides(p.id), getSettings(p.id)]);
      return {
        id: p.id,
        name: ov.hotelName || p.name,
        hasGeo: Boolean(settings.latitude && settings.longitude),
      };
    }),
  );

  const appUrl = getConfig().appUrl.replace(/\/+$/, "");
  return { collection, properties, appUrl };
}

export async function action({ params, request }: Route.ActionArgs) {
  await requireAdmin(request);
  // Ownership: must be one of the user's visible collections.
  const owned = (await getVisibleCollections(request)).some((c) => c.slug === params.slug);
  if (!owned) throw redirect("/admin/collections");

  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "delete") {
    await deleteCollection(params.slug);
    return redirect("/admin/collections");
  }

  const themeRaw = String(form.get("theme") || "").trim();
  const res = await updateCollection(params.slug, {
    name: String(form.get("name") || ""),
    slug: String(form.get("slug") || ""),
    destination: String(form.get("destination") || ""),
    heading: String(form.get("heading") || ""),
    intro: String(form.get("intro") || ""),
    phone: String(form.get("phone") || ""),
    propertyIds: form.getAll("propertyIds").map(String),
    theme: themeRaw === "custom" || isThemeId(themeRaw) ? (themeRaw as never) : undefined,
    customColor: String(form.get("customColor") || ""),
    customBg: String(form.get("customBg") || ""),
    themeFont: String(form.get("themeFont") || ""),
  });
  if ("error" in res) return { error: res.error };
  // Slug may have changed → land on the (possibly new) editor URL.
  return redirect(`/admin/collections/${res.collection.slug}`);
}

export function meta() {
  return [{ title: "Admin · Edit collection" }];
}

export default function AdminCollection({ loaderData, actionData }: Route.ComponentProps) {
  const { collection: c, properties, appUrl } = loaderData;
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const host = appUrl.replace(/^https?:\/\//, "");
  const selected = new Set(c.propertyIds);

  return (
    <div className="max-w-[720px]">
      <div className="mb-4">
        <Link to="/admin/collections" className="text-[13px] font-semibold text-muted hover:text-accent">
          ← All collections
        </Link>
      </div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-[26px] font-semibold">{c.name}</h1>
        <Link
          to={`/c/${c.slug}`}
          target="_blank"
          className="rounded-[10px] border border-line-alt bg-surface-alt px-[16px] py-[9px] text-[13px] font-semibold text-secondary hover:border-accent hover:text-accent"
        >
          View page ↗
        </Link>
      </div>

      <Form method="post" className="flex flex-col gap-6">
        <input type="hidden" name="intent" value="save" />

        {/* Identity */}
        <section className="rounded-[14px] border border-line bg-surface p-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-[13px] font-semibold text-secondary">
              Name
              <input name="name" defaultValue={c.name} className={FIELD_INPUT} />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Link
              <div className="mt-1.5 flex items-center rounded-[10px] border border-line-alt bg-surface-alt pl-3.5">
                <span className="text-[13px] text-muted-2">{host}/c/</span>
                <input
                  name="slug"
                  defaultValue={c.slug}
                  className="min-w-0 flex-1 bg-transparent px-1 py-[11px] text-[15px] text-ink outline-none"
                />
              </div>
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Destination <span className="font-normal text-faint">(eyebrow)</span>
              <input name="destination" defaultValue={c.destination} placeholder="Dublin" className={FIELD_INPUT} />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Phone <span className="font-normal text-faint">(header)</span>
              <input name="phone" defaultValue={c.phone} placeholder="+353 1 555 0192" className={FIELD_INPUT} />
            </label>
          </div>
          <label className="mt-4 block text-[13px] font-semibold text-secondary">
            Headline
            <input
              name="heading"
              defaultValue={c.heading}
              placeholder="Choose where you'll stay"
              className={FIELD_INPUT}
            />
            <span className="mt-1 block text-[11px] font-normal text-faint">
              The big title on the page. Leave blank for “Choose where you’ll stay”.
            </span>
          </label>
          <label className="mt-4 block text-[13px] font-semibold text-secondary">
            Intro
            <textarea
              name="intro"
              defaultValue={c.intro}
              rows={2}
              placeholder="Hotels, guesthouses and self-catering homes across the city — all bookable direct, with no booking fees."
              className={`${FIELD_INPUT} resize-y`}
            />
          </label>
        </section>

        {/* Properties */}
        <section className="rounded-[14px] border border-line bg-surface p-6">
          <div className="mb-1 font-serif text-[18px] font-semibold">Properties in this collection</div>
          <p className="mb-4 text-[13px] text-muted">
            Pick which of your properties appear on this landing page. Properties without map
            coordinates still list, but won’t get a map pin — set their location in{" "}
            <Link to="/admin/general" className="font-semibold text-accent hover:underline">General</Link>.
          </p>
          {properties.length === 0 ? (
            <p className="text-[13.5px] text-muted">You have no properties to add yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {properties.map((p) => (
                <label
                  key={p.id}
                  className="flex cursor-pointer items-center gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3"
                >
                  <input
                    type="checkbox"
                    name="propertyIds"
                    value={p.id}
                    defaultChecked={selected.has(p.id)}
                  />
                  <span className="flex-1 text-[14px] font-semibold text-ink">{p.name}</span>
                  {!p.hasGeo && (
                    <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-muted">
                      no map pin
                    </span>
                  )}
                </label>
              ))}
            </div>
          )}
        </section>

        {/* Theme */}
        <section className="rounded-[14px] border border-line bg-surface p-6">
          <div className="mb-3 font-serif text-[18px] font-semibold">Theme</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="block text-[13px] font-semibold text-secondary">
              Colour theme
              <select name="theme" defaultValue={c.theme ?? "terracotta"} className={FIELD_INPUT}>
                {THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Custom accent
              <input name="customColor" defaultValue={c.customColor} placeholder="#b5651d" className={FIELD_INPUT} />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              Custom background
              <input name="customBg" defaultValue={c.customBg} placeholder="#f7f2ec" className={FIELD_INPUT} />
            </label>
          </div>
          <label className="mt-4 block max-w-sm text-[13px] font-semibold text-secondary">
            Fonts
            <select name="themeFont" defaultValue={c.themeFont ?? "default"} className={FIELD_INPUT}>
              {FONT_PAIRS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
        </section>

        {actionData?.error && <p className="text-[13px] text-red-600">{actionData.error}</p>}

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save collection"}
          </button>
        </div>
      </Form>

      <Form
        method="post"
        className="mt-8 border-t border-divider pt-6"
        onSubmit={(e) => {
          if (!confirm(`Delete “${c.name}”? The properties themselves are kept.`)) e.preventDefault();
        }}
      >
        <input type="hidden" name="intent" value="delete" />
        <button type="submit" className="text-[13px] font-semibold text-[#c0392b] hover:underline">
          Delete this collection
        </button>
      </Form>
    </div>
  );
}
