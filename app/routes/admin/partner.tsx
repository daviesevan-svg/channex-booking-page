import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/partner";
import { adminMeta } from "~/lib/admin-meta";
import { FIELD_INPUT, FilePicker } from "~/components/admin-form";
import { resolveImageField, uploadPartnerFavicon, uploadPartnerLogo } from "~/lib/images.server";
import { useAdminT } from "~/lib/admin-i18n";
import { requireSuperadmin } from "~/lib/auth.server";
import {
  claimPartnerAdminHost,
  claimPartnerGuestHost,
  deletePartner,
  getPartner,
  releasePartnerAdminHost,
  releasePartnerGuestHost,
  savePartner,
} from "~/lib/partners.server";
import { normalizeDomain } from "~/lib/domains";
import { ensureCustomHostname } from "~/lib/custom-hostnames.server";
import { getConfig } from "~/lib/config.server";
import { getProperties, setPropertyPartner } from "~/lib/properties.server";
import { getUsers, setUserPartner } from "~/lib/users.server";

// One white-label partner (docs/whitelabel.md): superadmin-only branding,
// hostname, property and admin surgery. The list lives at /admin/partners.

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireSuperadmin(request);
  const partner = await getPartner(params.partnerId);
  if (!partner) throw redirect("/admin/partners");
  const [properties, users] = await Promise.all([getProperties(), getUsers()]);
  return {
    cnameTarget: getConfig().customHostnameTarget ?? null,
    partner: {
      ...partner,
      properties: properties.filter((x) => x.partnerId === partner.id).map((x) => ({ id: x.id, name: x.name })),
      admins: users.filter((u) => u.partnerId === partner.id && u.role === "partner_admin").map((u) => u.email),
    },
    // Direct properties are the only assignable ones — moving a hotel between
    // partners is deliberate two-step (unassign, then assign) so a typo can't
    // silently rebrand a live hotel.
    unassigned: properties.filter((x) => !x.partnerId).map((x) => ({ id: x.id, name: x.name })),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  await requireSuperadmin(request);
  const partnerId = params.partnerId;
  const partner = await getPartner(partnerId);
  if (!partner) throw redirect("/admin/partners");

  const form = await request.formData();
  const intent = String(form.get("intent"));
  const str = (k: string) => String(form.get(k) ?? "").trim();

  if (intent === "update") {
    const brandName = str("brandName");
    if (!brandName) return { error: "Enter the brand name their users will see." };
    // Admin host: claim before saving so a hostname another tenant holds never
    // lands in the record; release the previous one only after the new claim
    // stuck (a failed change must not drop the live door).
    const adminHost = normalizeDomain(str("adminHost")) || undefined;
    const guestHost = normalizeDomain(str("guestHost")) || undefined;
    let provisioning: string | null = null;
    if (adminHost !== partner.adminHost) {
      if (adminHost) {
        const claim = await claimPartnerAdminHost(partnerId, adminHost);
        if (!claim.ok) return { error: claim.error };
        const state = await ensureCustomHostname(adminHost);
        provisioning = state.kind;
      }
      await releasePartnerAdminHost(partnerId, partner.adminHost);
    }
    if (guestHost !== partner.guestHost) {
      if (guestHost) {
        const claim = await claimPartnerGuestHost(partnerId, guestHost);
        if (!claim.ok) return { error: claim.error };
        const state = await ensureCustomHostname(guestHost);
        provisioning = provisioning ?? state.kind;
      }
      await releasePartnerGuestHost(partnerId, partner.guestHost);
    }
    // Brand assets. Replaced/removed files are left in R2 — the image GC is
    // property-scoped and partner uploads are superadmin-rare; orphaned bytes
    // are cheaper than teaching the sweeper a second ownership model.
    const logo = await resolveImageField(form, {
      fileKey: "logoUpload",
      removeKey: "removeLogo",
      previous: partner.logoImage,
      upload: (f) => uploadPartnerLogo(partnerId, f),
    });
    if (!logo.ok) return { error: logo.error };
    const favicon = await resolveImageField(form, {
      fileKey: "faviconUpload",
      removeKey: "removeFavicon",
      previous: partner.faviconImage,
      upload: (f) => uploadPartnerFavicon(partnerId, f),
    });
    if (!favicon.ok) return { error: favicon.error };
    const logoImage = logo.url;
    const faviconImage = favicon.url;
    // Their sending address — the domain is verified by hand in SparkPost, so
    // the only guard worth having here is "looks like one email address" (a
    // stray display name or comma would corrupt every From header we build).
    const emailFrom = str("emailFrom").toLowerCase() || undefined;
    if (emailFrom && !/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(emailFrom)) {
      return { error: "Sending address must be a bare email address like noreply@theirpms.com." };
    }
    await savePartner({
      ...partner,
      name: str("name") || brandName,
      brandName,
      supportEmail: str("supportEmail") || undefined,
      emailFrom,
      adminHost,
      guestHost,
      logoImage,
      faviconImage,
    });
    if (provisioning) return { ok: true as const, provisioning };
  } else if (intent === "assignProperty") {
    const propertyId = str("propertyId");
    const all = await getProperties();
    const target = all.find((p) => p.id === propertyId);
    // Only direct properties are assignable here (see loader note).
    if (target && !target.partnerId) await setPropertyPartner(propertyId, partnerId);
  } else if (intent === "unassignProperty") {
    await setPropertyPartner(str("propertyId"), undefined);
  } else if (intent === "addAdmin") {
    const email = str("email").toLowerCase();
    if (email) await setUserPartner(email, partnerId, "partner_admin");
  } else if (intent === "removeAdmin") {
    const email = str("email").toLowerCase();
    // Back to a plain direct member; their property team memberships survive.
    if (email) await setUserPartner(email, undefined, "member");
  } else if (intent === "delete") {
    // Only an EMPTY partner can go — a dangling partnerId on a property or
    // user would strand it invisible to everyone but superadmins. Unassign
    // properties and remove admins first; that friction is the safety.
    const [properties, users] = await Promise.all([getProperties(), getUsers()]);
    if (properties.some((p) => p.partnerId === partnerId) || users.some((u) => u.partnerId === partnerId)) {
      return { error: "Unassign this partner's properties and remove its admins first." };
    }
    await deletePartner(partner);
    return redirect("/admin/partners");
  }
  return redirect(`/admin/partners/${partnerId}`);
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "navPartners" });
}

const label = "mb-1 block text-[11px] font-semibold uppercase tracking-wider text-faint";

export default function AdminPartner({ loaderData, actionData }: Route.ComponentProps) {
  const { partner: p, unassigned, cnameTarget } = loaderData;
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const t = useAdminT();
  // Filter for the assign picker — the unassigned list is every direct
  // property on the platform, far too long to scan by eye.
  const [assignQ, setAssignQ] = useState("");
  const needle = assignQ.trim().toLowerCase();
  const assignable = needle ? unassigned.filter((u) => u.name.toLowerCase().includes(needle)) : unassigned;

  return (
    <div>
      <Link
        to="/admin/partners"
        className="mb-4 inline-block text-[13px] font-semibold text-muted hover:text-accent"
      >
        {t("wlpBackAll")}
      </Link>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <h1 className="font-serif text-[26px] font-semibold">{p.brandName}</h1>
          <code className="rounded bg-chip px-1.5 py-0.5 text-[11px] text-muted">{p.id}</code>
        </div>
        {p.properties.length === 0 && p.admins.length === 0 && (
          <Form
            method="post"
            onSubmit={(e) => {
              if (!confirm(t("wlpDeleteConfirm", { name: p.brandName }))) e.preventDefault();
            }}
          >
            <input type="hidden" name="intent" value="delete" />
            <button type="submit" disabled={busy} className="text-[13px] font-semibold text-[#c0392b] hover:underline">
              {t("wlpDelete")}
            </button>
          </Form>
        )}
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <p className="mb-4 text-[13px] text-red-600">{actionData.error}</p>
      )}
      {actionData && "provisioning" in actionData && actionData.provisioning && (
        <p className="mb-4 rounded-[10px] bg-chip px-4 py-2.5 text-[13px] text-secondary">
          {t("wlpProvisioningState")} <code className="text-[12px]">{actionData.provisioning}</code>
        </p>
      )}

      <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
        <div className="grid gap-6 px-5 py-4 lg:grid-cols-2">
          {/* branding / contact */}
          <Form method="post" encType="multipart/form-data" className="space-y-3">
            <input type="hidden" name="intent" value="update" />
            <div>
              <span className={label}>{t("wlpBrandName")}</span>
              <input name="brandName" defaultValue={p.brandName} className={FIELD_INPUT} />
              <span className="mt-1 block text-[12px] text-faint">{t("wlpBrandNameHint")}</span>
            </div>
            <div>
              <span className={label}>{t("wlpInternalName")}</span>
              <input name="name" defaultValue={p.name} className={FIELD_INPUT} />
            </div>
            <div>
              <span className={label}>{t("wlpSupportEmail")}</span>
              <input name="supportEmail" type="email" defaultValue={p.supportEmail} placeholder="support@pms.com" className={FIELD_INPUT} />
              <span className="mt-1 block text-[12px] text-faint">{t("wlpSupportEmailHint")}</span>
            </div>
            <div>
              <span className={label}>{t("wlpEmailFrom")}</span>
              <input
                name="emailFrom"
                type="email"
                defaultValue={p.emailFrom}
                placeholder="noreply@theirpms.com"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className={FIELD_INPUT}
              />
              <span className="mt-1 block text-[12px] text-faint">{t("wlpEmailFromHint")}</span>
            </div>
            <div>
              <span className={label}>{t("wlpAdminHost")}</span>
              <input
                name="adminHost"
                defaultValue={p.adminHost}
                placeholder="admin.theirpms.com"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className={FIELD_INPUT}
              />
              <span className="mt-1 block text-[12px] text-faint">{t("wlpAdminHostHint")}</span>
              {cnameTarget && (
                <span className="mt-1 block text-[12px] text-faint">
                  {t("wlpAdminHostDns")}{" "}
                  <code className="rounded bg-chip px-1 py-0.5 text-[11px]">CNAME → {cnameTarget}</code>
                </span>
              )}
            </div>
            <div>
              <span className={label}>{t("wlpGuestHost")}</span>
              <input
                name="guestHost"
                defaultValue={p.guestHost}
                placeholder="book.theirpms.com"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className={FIELD_INPUT}
              />
              <span className="mt-1 block text-[12px] text-faint">{t("wlpGuestHostHint")}</span>
            </div>
            <div>
              <span className={label}>{t("wlpLogo")}</span>
              <div className="flex items-center gap-3">
                {p.logoImage && (
                  <img src={p.logoImage} alt="" className="h-8 max-w-[140px] rounded-[6px] bg-chip object-contain px-1.5" />
                )}
                <FilePicker name="logoUpload" accept="image/*" />
              </div>
              <span className="mt-1 block text-[12px] text-faint">{t("wlpLogoHint")}</span>
              {p.logoImage && (
                <label className="mt-1 flex items-center gap-2 text-[12px] text-secondary">
                  <input type="checkbox" name="removeLogo" value="1" />
                  {t("wlpRemove")}
                </label>
              )}
            </div>
            <div>
              <span className={label}>{t("wlpFavicon")}</span>
              <div className="flex items-center gap-3">
                {p.faviconImage && (
                  <img src={p.faviconImage} alt="" className="h-6 w-6 rounded-[4px] bg-chip object-contain" />
                )}
                <FilePicker name="faviconUpload" accept="image/png,image/x-icon,image/svg+xml,image/vnd.microsoft.icon" />
              </div>
              <span className="mt-1 block text-[12px] text-faint">{t("wlpFaviconHint")}</span>
              {p.faviconImage && (
                <label className="mt-1 flex items-center gap-2 text-[12px] text-secondary">
                  <input type="checkbox" name="removeFavicon" value="1" />
                  {t("wlpRemove")}
                </label>
              )}
            </div>
            <button type="submit" disabled={busy} className="rounded-[10px] bg-accent px-4 py-2 text-[13px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60">
              {t("saveChanges")}
            </button>
          </Form>

          <div className="space-y-5">
            {/* properties */}
            <div>
              <div className={label}>{t("wlpProperties")}</div>
              {p.properties.length === 0 && <p className="text-[13px] text-muted">{t("wlpNoProperties")}</p>}
              <ul className="space-y-1">
                {p.properties.map((prop) => (
                  <li key={prop.id} className="flex items-center justify-between gap-2 text-[13px]">
                    <span className="min-w-0 truncate">{prop.name}</span>
                    <Form method="post">
                      <input type="hidden" name="intent" value="unassignProperty" />
                      <input type="hidden" name="propertyId" value={prop.id} />
                      <button type="submit" disabled={busy} className="font-semibold text-[#c0392b] hover:underline">
                        {t("wlpUnassign")}
                      </button>
                    </Form>
                  </li>
                ))}
              </ul>
              {unassigned.length > 0 ? (
                <Form method="post" className="mt-2 space-y-2">
                  <input type="hidden" name="intent" value="assignProperty" />
                  <input
                    value={assignQ}
                    onChange={(e) => setAssignQ(e.target.value)}
                    // Enter here must not submit — with the select filtered, the
                    // form would silently assign the first match.
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.preventDefault();
                    }}
                    placeholder={t("searchProperties")}
                    aria-label={t("searchProperties")}
                    className="w-full rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
                  />
                  {assignable.length > 0 ? (
                    <div className="flex items-center gap-2">
                      <select name="propertyId" className="min-w-0 flex-1 rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent">
                        {assignable.map((u) => (
                          <option key={u.id} value={u.id}>{u.name}</option>
                        ))}
                      </select>
                      <button type="submit" disabled={busy} className="rounded-[8px] border border-line-alt px-3 py-1.5 text-[13px] font-semibold hover:border-accent hover:text-accent">
                        {t("wlpAssign")}
                      </button>
                    </div>
                  ) : (
                    <p className="text-[12px] text-muted">{t("noPropertiesMatch", { q: assignQ.trim() })}</p>
                  )}
                </Form>
              ) : (
                <p className="mt-2 text-[12px] text-faint">{t("wlpNoUnassigned")}</p>
              )}
            </div>

            {/* partner admins */}
            <div>
              <div className={label}>{t("wlpAdmins")}</div>
              {p.admins.length === 0 && <p className="text-[13px] text-muted">{t("wlpNoAdmins")}</p>}
              <ul className="space-y-1">
                {p.admins.map((email) => (
                  <li key={email} className="flex items-center justify-between gap-2 text-[13px]">
                    <span className="min-w-0 truncate">{email}</span>
                    <Form method="post">
                      <input type="hidden" name="intent" value="removeAdmin" />
                      <input type="hidden" name="email" value={email} />
                      <button type="submit" disabled={busy} className="font-semibold text-[#c0392b] hover:underline">
                        {t("wlpRemove")}
                      </button>
                    </Form>
                  </li>
                ))}
              </ul>
              <Form method="post" className="mt-2 flex items-center gap-2">
                <input type="hidden" name="intent" value="addAdmin" />
                <input name="email" type="email" required placeholder="admin@pms.com" className="min-w-0 flex-1 rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent" />
                <button type="submit" disabled={busy} className="rounded-[8px] border border-line-alt px-3 py-1.5 text-[13px] font-semibold hover:border-accent hover:text-accent">
                  {t("wlpAdd")}
                </button>
              </Form>
              <p className="mt-1 text-[12px] text-faint">{t("wlpAdminHint")}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
