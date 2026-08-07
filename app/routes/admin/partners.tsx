import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/partners";
import { adminMeta } from "~/lib/admin-meta";
import { FIELD_INPUT } from "~/components/admin-form";
import { useAdminT } from "~/lib/admin-i18n";
import { requireSuperadmin } from "~/lib/auth.server";
import {
  DEFAULT_HIDDEN_PAGES,
  getPartner,
  getPartners,
  isValidPartnerId,
  savePartner,
  type Partner,
} from "~/lib/partners.server";
import { getProperties, slugify } from "~/lib/properties.server";
import { getUsers } from "~/lib/users.server";

// White-label partners (docs/whitelabel.md): superadmin-only list of the PMSs
// reselling the booking engine. Each row opens /admin/partners/:partnerId,
// where all the actual surgery (branding, hosts, properties, admins) lives.

export async function loader({ request }: Route.LoaderArgs) {
  await requireSuperadmin(request);
  const [partners, properties, users] = await Promise.all([getPartners(), getProperties(), getUsers()]);
  return {
    partners: partners.map((p) => ({
      id: p.id,
      brandName: p.brandName,
      supportEmail: p.supportEmail,
      adminHost: p.adminHost,
      guestHost: p.guestHost,
      logoImage: p.logoImage,
      propertyCount: properties.filter((x) => x.partnerId === p.id).length,
      adminCount: users.filter((u) => u.partnerId === p.id && u.role === "partner_admin").length,
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireSuperadmin(request);
  const form = await request.formData();
  const str = (k: string) => String(form.get(k) ?? "").trim();

  const brandName = str("brandName");
  if (!brandName) return { error: "Enter the brand name their users will see." };
  const name = str("name") || brandName;
  // The id is internal (a KV key and a foreign key on properties/users) and
  // never shown to their users, so it's derived rather than asked for: the
  // slugified name, uniquified with a numeric suffix. Non-Latin names can
  // slugify to nothing — fall back to a generic stem rather than erroring.
  let base = slugify(name);
  if (!isValidPartnerId(base)) base = "partner";
  let id = base;
  for (let n = 2; await getPartner(id); n++) id = `${base}-${n}`;
  const partner: Partner = {
    id,
    name,
    brandName,
    supportEmail: str("supportEmail") || undefined,
    hiddenPages: [...DEFAULT_HIDDEN_PAGES],
    createdAt: Date.now(),
  };
  await savePartner(partner);
  // Straight to the new partner's page — hosts, logo and admins live there.
  return redirect(`/admin/partners/${id}`);
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "navPartners" });
}

const label = "mb-1 block text-[11px] font-semibold uppercase tracking-wider text-faint";

export default function AdminPartners({ loaderData, actionData }: Route.ComponentProps) {
  const { partners } = loaderData;
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const t = useAdminT();
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-serif text-[26px] font-semibold">{t("wlpTitle")}</h1>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-[10px] bg-accent px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep"
          >
            {t("wlpCreateTitle")}
          </button>
        )}
      </div>
      <p className="mb-6 text-[14px] text-muted">{t("wlpIntro")}</p>

      {actionData && "error" in actionData && actionData.error && (
        <p className="mb-4 text-[13px] text-red-600">{actionData.error}</p>
      )}

      {creating && (
        <div className="mb-5 rounded-[14px] border border-line bg-surface p-5">
          <h2 className="mb-3 font-serif text-[18px] font-semibold">{t("wlpCreateTitle")}</h2>
          <Form method="post" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <span className={label}>{t("wlpBrandName")}</span>
              <input name="brandName" required autoFocus placeholder="HotelSoft Bookings" className={FIELD_INPUT} />
              <span className="mt-1 block text-[12px] text-faint">{t("wlpBrandNameHint")}</span>
            </div>
            <div>
              <span className={label}>{t("wlpInternalName")}</span>
              <input name="name" placeholder="HotelSoft Ltd" className={FIELD_INPUT} />
            </div>
            <div>
              <span className={label}>{t("wlpSupportEmail")}</span>
              <input name="supportEmail" type="email" placeholder="support@pms.com" className={FIELD_INPUT} />
            </div>
            <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-3">
              <button type="submit" disabled={busy} className="rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60">
                {t("wlpCreate")}
              </button>
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded-[10px] border border-line-alt px-4 py-2.5 text-[14px] font-semibold text-secondary hover:border-accent hover:text-accent"
              >
                {t("wlpCancel")}
              </button>
            </div>
          </Form>
        </div>
      )}

      {partners.length === 0 ? (
        !creating && (
          <div className="rounded-[14px] border border-line bg-surface p-6 text-[14px] text-secondary">
            {t("wlpEmpty")}
          </div>
        )
      ) : (
        <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
          {partners.map((p, i) => (
            <Link
              key={p.id}
              to={`/admin/partners/${p.id}`}
              className={`flex items-center justify-between gap-4 px-5 py-4 hover:bg-field-hover ${
                i > 0 ? "border-t border-divider" : ""
              }`}
            >
              <div className="flex min-w-0 items-center gap-3">
                {p.logoImage && (
                  <img src={p.logoImage} alt="" className="h-8 max-w-[110px] flex-none rounded-[6px] bg-chip object-contain px-1.5" />
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <span className="truncate font-semibold">{p.brandName}</span>
                    <code className="rounded bg-chip px-1.5 py-0.5 text-[11px] text-muted">{p.id}</code>
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-muted-2">
                    {t(p.propertyCount === 1 ? "wlpPropsCount_one" : "wlpPropsCount_other", { n: p.propertyCount })} ·{" "}
                    {t(p.adminCount === 1 ? "wlpAdminsCount_one" : "wlpAdminsCount_other", { n: p.adminCount })}
                    {p.adminHost ? <> · {p.adminHost}</> : null}
                    {p.guestHost ? <> · {p.guestHost}</> : null}
                  </div>
                </div>
              </div>
              <span className="flex-none text-[13px] font-semibold text-accent">{t("wlpManage")}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
