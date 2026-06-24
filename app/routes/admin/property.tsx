import { Form, useNavigation } from "react-router";

import type { Route } from "./+types/property";
import { Field } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import { getChannexClient, getConfig } from "~/lib/config.server";
import { langParam, pickLang } from "~/lib/content";
import { getOverridesRaw, saveOverrides } from "~/lib/overrides.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) return { configured: false as const };

  const lang = langParam(request);
  const property = await getChannexClient().getPropertyInfo(propertyId).catch(() => null);
  const overrides = await getOverridesRaw(propertyId, lang);
  return {
    configured: true as const,
    propertyId,
    lang,
    overrides,
    defaults: {
      hotelName: property?.title ?? "",
      address: property?.address ?? "",
      description: property?.description ?? "",
      phone: property?.phone ?? "",
      email: property?.email ?? "",
    },
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) return { error: "No DEFAULT_PROPERTY_ID is configured." };
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
          Set <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code> to edit a
          property here.
        </p>
      </div>
    );
  }

  const { overrides, defaults, lang } = loaderData;

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
        These override what guests see in the booking engine. Empty fields fall back to Channex.
      </p>

      <Form
        method="post"
        key={lang}
        className="flex flex-col gap-5 rounded-[14px] border border-line bg-surface p-6"
      >
        <input type="hidden" name="lang" value={lang} />
        <Field name="hotelName" label="Hotel name" value={overrides.hotelName} placeholder={defaults.hotelName} channexHint />
        <Field name="address" label="Address" value={overrides.address} placeholder={defaults.address} channexHint />
        <Field name="description" label="Description" value={overrides.description} placeholder={defaults.description} textarea rows={4} channexHint />
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field name="phone" label="Phone" value={overrides.phone} placeholder={defaults.phone} channexHint />
          <Field name="email" label="Email" value={overrides.email} placeholder={defaults.email} channexHint />
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
