import { Form, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/page";
import { requireAdmin } from "~/lib/auth.server";
import { getConfig } from "~/lib/config.server";
import { pageDef } from "~/lib/content";
import { getPageOverrides, savePageContent } from "~/lib/overrides.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const def = pageDef(params.page);
  if (!def) throw redirect("/admin");
  const propertyId = getConfig().defaultPropertyId;
  const overrides = propertyId ? await getPageOverrides(propertyId, params.page) : {};
  return { configured: Boolean(propertyId), page: params.page, label: def.label, fields: def.fields, overrides };
}

export async function action({ params, request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };
  await savePageContent(propertyId, params.page, Object.fromEntries(await request.formData()));
  return { ok: true };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Admin · ${loaderData?.label ?? "Page"}` }];
}

export default function AdminPage({ loaderData, actionData }: Route.ComponentProps) {
  const { configured, label, fields, overrides } = loaderData;
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  if (!configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">{label}</h1>
        <p className="text-[15px] text-secondary">
          Set <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code> to edit
          page content.
        </p>
      </div>
    );
  }

  const inputCls =
    "mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[11px] text-[15px] text-ink outline-none focus:border-accent";

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">{label} page</h1>
        {actionData?.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            ✓ Saved
          </span>
        )}
      </div>
      <p className="mb-6 text-[14px] text-muted">
        Text guests see on the {label.toLowerCase()} screen. Empty fields use the defaults shown.
      </p>

      <Form
        method="post"
        key={loaderData.page}
        className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6"
      >
        {fields.map((f) => (
          <label key={f.key} className="block text-[13px] font-semibold text-secondary">
            {f.label}
            {f.textarea ? (
              <textarea
                name={f.key}
                rows={3}
                defaultValue={overrides[f.key]}
                placeholder={f.default}
                className={`${inputCls} resize-y`}
              />
            ) : (
              <input
                name={f.key}
                defaultValue={overrides[f.key]}
                placeholder={f.default}
                className={inputCls}
              />
            )}
          </label>
        ))}

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
