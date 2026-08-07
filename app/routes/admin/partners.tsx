import { Form, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/partners";
import { adminMeta } from "~/lib/admin-meta";
import { FIELD_INPUT, FilePicker } from "~/components/admin-form";
import { uploadPartnerFavicon, uploadPartnerLogo } from "~/lib/images.server";
import { useAdminT } from "~/lib/admin-i18n";
import { requireSuperadmin } from "~/lib/auth.server";
import {
  claimPartnerAdminHost,
  claimPartnerGuestHost,
  DEFAULT_HIDDEN_PAGES,
  deletePartner,
  getPartner,
  getPartners,
  isValidPartnerId,
  releasePartnerAdminHost,
  releasePartnerGuestHost,
  savePartner,
  type Partner,
} from "~/lib/partners.server";
import { normalizeDomain } from "~/lib/domains";
import { ensureCustomHostname } from "~/lib/custom-hostnames.server";
import { getConfig } from "~/lib/config.server";
import { getProperties, setPropertyPartner, slugify } from "~/lib/properties.server";
import { getUsers, setUserPartner } from "~/lib/users.server";

// White-label partners (docs/whitelabel.md): superadmin-only management of the
// PMSs reselling the booking engine. Everything here is registry surgery —
// stamping partnerId on properties/users and editing partner branding config.

export async function loader({ request }: Route.LoaderArgs) {
  await requireSuperadmin(request);
  const [partners, properties, users] = await Promise.all([getPartners(), getProperties(), getUsers()]);
  return {
    cnameTarget: getConfig().customHostnameTarget ?? null,
    partners: partners.map((p) => ({
      ...p,
      properties: properties.filter((x) => x.partnerId === p.id).map((x) => ({ id: x.id, name: x.name })),
      admins: users.filter((u) => u.partnerId === p.id && u.role === "partner_admin").map((u) => u.email),
    })),
    // Direct properties are the only assignable ones — moving a hotel between
    // partners is deliberate two-step (unassign, then assign) so a typo can't
    // silently rebrand a live hotel.
    unassigned: properties.filter((x) => !x.partnerId).map((x) => ({ id: x.id, name: x.name })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireSuperadmin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const partnerId = String(form.get("partnerId") || "").trim().toLowerCase();
  const str = (k: string) => String(form.get(k) ?? "").trim();

  if (intent === "create") {
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
    return redirect("/admin/partners");
  }

  const partner = await getPartner(partnerId);
  if (!partner) return { error: "Unknown partner." };

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
    let logoImage = partner.logoImage;
    let faviconImage = partner.faviconImage;
    try {
      const logoUpload = form.get("logoUpload");
      if (logoUpload instanceof File && logoUpload.size > 0) {
        logoImage = await uploadPartnerLogo(partnerId, logoUpload);
      } else if (form.get("removeLogo") === "1") logoImage = undefined;
      const faviconUpload = form.get("faviconUpload");
      if (faviconUpload instanceof File && faviconUpload.size > 0) {
        faviconImage = await uploadPartnerFavicon(partnerId, faviconUpload);
      } else if (form.get("removeFavicon") === "1") faviconImage = undefined;
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Upload failed." };
    }
    await savePartner({
      ...partner,
      name: str("name") || brandName,
      brandName,
      supportEmail: str("supportEmail") || undefined,
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
  }
  return redirect("/admin/partners");
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "navPartners" });
}

const label = "mb-1 block text-[11px] font-semibold uppercase tracking-wider text-faint";

export default function AdminPartners({ loaderData, actionData }: Route.ComponentProps) {
  const { partners, unassigned, cnameTarget } = loaderData;
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const t = useAdminT();

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">{t("wlpTitle")}</h1>
      <p className="mb-6 text-[14px] text-muted">{t("wlpIntro")}</p>

      {actionData && "error" in actionData && actionData.error && (
        <p className="mb-4 text-[13px] text-red-600">{actionData.error}</p>
      )}
      {actionData && "provisioning" in actionData && actionData.provisioning && (
        <p className="mb-4 rounded-[10px] bg-chip px-4 py-2.5 text-[13px] text-secondary">
          {t("wlpProvisioningState")} <code className="text-[12px]">{actionData.provisioning}</code>
        </p>
      )}

      {partners.map((p) => (
        <div key={p.id} className="mb-5 overflow-hidden rounded-[14px] border border-line bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-divider bg-surface-alt/50 px-5 py-3">
            <div className="flex items-center gap-2.5">
              <span className="font-serif text-[17px] font-semibold">{p.brandName}</span>
              <code className="rounded bg-chip px-1.5 py-0.5 text-[11px] text-muted">{p.id}</code>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[12px] text-muted-2">
                {t(p.properties.length === 1 ? "wlpPropsCount_one" : "wlpPropsCount_other", { n: p.properties.length })}
              </span>
              {p.properties.length === 0 && p.admins.length === 0 && (
                <Form
                  method="post"
                  onSubmit={(e) => {
                    if (!confirm(t("wlpDeleteConfirm", { name: p.brandName }))) e.preventDefault();
                  }}
                >
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="partnerId" value={p.id} />
                  <button type="submit" disabled={busy} className="text-[12px] font-semibold text-[#c0392b] hover:underline">
                    {t("wlpDelete")}
                  </button>
                </Form>
              )}
            </div>
          </div>

          <div className="grid gap-6 px-5 py-4 lg:grid-cols-2">
            {/* branding / contact */}
            <Form method="post" encType="multipart/form-data" className="space-y-3">
              <input type="hidden" name="intent" value="update" />
              <input type="hidden" name="partnerId" value={p.id} />
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
                        <input type="hidden" name="partnerId" value={p.id} />
                        <input type="hidden" name="propertyId" value={prop.id} />
                        <button type="submit" disabled={busy} className="font-semibold text-[#c0392b] hover:underline">
                          {t("wlpUnassign")}
                        </button>
                      </Form>
                    </li>
                  ))}
                </ul>
                {unassigned.length > 0 ? (
                  <Form method="post" className="mt-2 flex items-center gap-2">
                    <input type="hidden" name="intent" value="assignProperty" />
                    <input type="hidden" name="partnerId" value={p.id} />
                    <select name="propertyId" className="min-w-0 flex-1 rounded-[8px] border border-line-alt bg-surface-alt px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent">
                      {unassigned.map((u) => (
                        <option key={u.id} value={u.id}>{u.name}</option>
                      ))}
                    </select>
                    <button type="submit" disabled={busy} className="rounded-[8px] border border-line-alt px-3 py-1.5 text-[13px] font-semibold hover:border-accent hover:text-accent">
                      {t("wlpAssign")}
                    </button>
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
                        <input type="hidden" name="partnerId" value={p.id} />
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
                  <input type="hidden" name="partnerId" value={p.id} />
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
      ))}

      {/* create */}
      <div className="rounded-[14px] border border-line bg-surface p-5">
        <h2 className="mb-3 font-serif text-[18px] font-semibold">{t("wlpCreateTitle")}</h2>
        <Form method="post" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <input type="hidden" name="intent" value="create" />
          <div>
            <span className={label}>{t("wlpBrandName")}</span>
            <input name="brandName" required placeholder="HotelSoft Bookings" className={FIELD_INPUT} />
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
          <div className="sm:col-span-2 lg:col-span-4">
            <button type="submit" disabled={busy} className="rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60">
              {t("wlpCreate")}
            </button>
          </div>
        </Form>
      </div>
    </div>
  );
}
