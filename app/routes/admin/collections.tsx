import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/collections";
import { FIELD_INPUT } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import {
  canAccessCollection,
  createCollection,
  deleteCollection,
  getVisibleCollections,
} from "~/lib/collections.server";
import { getConfig } from "~/lib/config.server";
import { useAdminT } from "~/lib/admin-i18n";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const collections = await getVisibleCollections(request);
  const appUrl = getConfig().appUrl.replace(/\/+$/, "");
  return { collections, appUrl };
}

export async function action({ request }: Route.ActionArgs) {
  const email = await requireAdmin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "add") {
    const name = String(form.get("name") || "").trim();
    if (!name) return { error: "Give your collection a name." };
    const col = await createCollection(name, email);
    return redirect(`/admin/collections/${col.slug}`);
  }

  if (intent === "delete") {
    const slug = String(form.get("slug") || "");
    if (await canAccessCollection(request, slug)) await deleteCollection(slug);
    return redirect("/admin/collections");
  }

  return redirect("/admin/collections");
}

export function meta() {
  return [{ title: "Admin · Collections" }];
}

export default function AdminCollections({ loaderData, actionData }: Route.ComponentProps) {
  const { collections, appUrl } = loaderData;
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const host = appUrl.replace(/^https?:\/\//, "");
  const t = useAdminT();

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">{t("coTitle")}</h1>
      <p className="mb-6 max-w-[640px] text-[14px] text-muted">{t("coIntro")}</p>

      {collections.length === 0 && (
        <div className="mb-7 rounded-[14px] border border-dashed border-line bg-surface px-5 py-6 text-[14px] text-muted">
          {t("coEmpty")}
        </div>
      )}

      {collections.length > 0 && (
        <div className="mb-7 overflow-hidden rounded-[14px] border border-line bg-surface">
          {collections.map((c, i) => (
            <div
              key={c.slug}
              className={`flex flex-wrap items-center justify-between gap-3 px-5 py-4 ${
                i > 0 ? "border-t border-divider" : ""
              }`}
            >
              <div className="min-w-0">
                <div className="font-semibold">{c.name}</div>
                <div className="mt-0.5 font-mono text-[12px] text-muted-2">
                  {host}/c/{c.slug}
                </div>
                <div className="mt-0.5 text-[12px] text-muted">
                  {t(c.propertyIds.length === 1 ? "coProperties_one" : "coProperties_other", {
                    n: c.propertyIds.length,
                  })}
                  {c.destination ? ` · ${c.destination}` : ""}
                </div>
              </div>
              <div className="flex flex-none items-center gap-4 text-[13px] font-semibold">
                <Link to={`/c/${c.slug}`} target="_blank" className="text-muted hover:text-accent">
                  {t("coView")}
                </Link>
                <Link to={`/admin/collections/${c.slug}`} className="text-accent hover:underline">
                  {t("coEdit")}
                </Link>
                <Form
                  method="post"
                  onSubmit={(e) => {
                    if (!confirm(t("coDeleteConfirm", { name: c.name }))) e.preventDefault();
                  }}
                >
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="slug" value={c.slug} />
                  <button type="submit" className="text-[#c0392b] hover:underline">
                    {t("coDelete")}
                  </button>
                </Form>
              </div>
            </div>
          ))}
        </div>
      )}

      <Form method="post" className="flex flex-col gap-4 rounded-[14px] border border-line bg-surface p-6">
        <input type="hidden" name="intent" value="add" />
        <h2 className="font-serif text-[18px] font-semibold">{t("coNewCollection")}</h2>
        <label className="block max-w-md text-[13px] font-semibold text-secondary">
          {t("coName")}
          <input name="name" placeholder="The Laurel Collection" className={FIELD_INPUT} />
          <span className="mt-1 block text-[11px] font-normal text-faint">
            {t("coNameHint", { host })}
          </span>
        </label>
        {actionData?.error && <p className="text-[13px] text-red-600">{actionData.error}</p>}
        <div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? t("coCreating") : t("coCreate")}
          </button>
        </div>
      </Form>
    </div>
  );
}
