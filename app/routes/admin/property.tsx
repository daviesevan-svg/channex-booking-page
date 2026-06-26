import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/property";
import { Field } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { langParam, pickLang } from "~/lib/content";
import { getOverridesRaw, saveOverrides } from "~/lib/overrides.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };

  const lang = langParam(request);
  const overrides = await getOverridesRaw(propertyId, lang);
  return { configured: true as const, propertyId, lang, overrides };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "Add a property first." };
  const form = await request.formData();
  await saveOverrides(propertyId, pickLang(String(form.get("lang") ?? "")), Object.fromEntries(form));
  return { ok: true };
}

export function meta() {
  return [{ title: "Admin · Property details" }];
}

export default function AdminProperty({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Property details</h1>
        <p className="text-[15px] text-secondary">
          Add a property on the{" "}
          <a href="/admin/properties" className="font-semibold text-accent hover:underline">
            Properties
          </a>{" "}
          page to get started.
        </p>
      </div>
    );
  }

  const { overrides, lang } = loaderData;

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">Property details</h1>
        {actionData?.ok && (
          <span className="rounded-full bg-[#e8f0e6] px-3 py-1 text-[13px] font-semibold text-[#3f7a52]">
            ✓ Saved
          </span>
        )}
      </div>
      <p className="mb-6 text-[14px] text-muted">
        The hotel details guests see across the booking engine.
      </p>

      <Form
        method="post"
        key={lang}
        className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6"
      >
        <input type="hidden" name="lang" value={lang} />
        <Field name="hotelName" label="Hotel name" value={overrides.hotelName} placeholder="Spilman Hotel" />
        <Field name="address" label="Address" value={overrides.address} placeholder="123 High Street, Carmarthen" />
        <Field name="description" label="Description" value={overrides.description} textarea rows={4} />
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field name="phone" label="Phone" value={overrides.phone} placeholder="+44 …" />
          <Field name="email" label="Email" value={overrides.email} placeholder="stay@hotel.com" />
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
