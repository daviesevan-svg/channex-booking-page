import { Form, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/page";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { langParam, pageDef, pickLang } from "~/lib/content";
import { getPageOverridesRaw, savePageContent } from "~/lib/overrides.server";
import { FIELD_INPUT } from "~/components/admin-form";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const def = pageDef(params.page);
  if (!def) throw redirect("/admin");
  const propertyId = await currentPropertyId(request);
  const lang = langParam(request);
  const overrides = propertyId ? await getPageOverridesRaw(propertyId, params.page, lang) : {};
  return { configured: Boolean(propertyId), page: params.page, label: def.label, fields: def.fields, overrides, lang };
}

export async function action({ params, request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID configured." };
  const form = await request.formData();
  await savePageContent(propertyId, params.page, pickLang(String(form.get("lang") ?? "")), Object.fromEntries(form));
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

  const inputCls = FIELD_INPUT;

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
        key={loaderData.page + loaderData.lang}
        className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6"
      >
        <input type="hidden" name="lang" value={loaderData.lang} />
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
