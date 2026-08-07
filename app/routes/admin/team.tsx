import { Form, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/team";
import { adminMeta } from "~/lib/admin-meta";
import { FIELD_INPUT } from "~/components/admin-form";
import { useAdminT } from "~/lib/admin-i18n";
import { requireAdmin } from "~/lib/auth.server";
import { sendTeamInviteEmail } from "~/lib/email.server";
import {
  addPropertyMember,
  currentPropertyId,
  getProperty,
  isOwnerOrSuper,
  removePropertyMember,
  setMemberHiddenAreas,
} from "~/lib/properties.server";
import { isMemberArea, MEMBER_AREAS, type MemberArea } from "~/lib/member-areas";
import { getUser, setUserPartner, upsertUser } from "~/lib/users.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  // Only the owner (or a superadmin) manages a property's team.
  if (!propertyId || !(await isOwnerOrSuper(request, propertyId))) throw redirect("/admin");
  const property = await getProperty(propertyId);
  return {
    propertyId,
    name: property?.name ?? "",
    owner: property?.owner ?? null,
    members: property?.members ?? [],
    memberHiddenAreas: property?.memberHiddenAreas ?? {},
  };
}

export async function action({ request }: Route.ActionArgs) {
  const inviter = await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId || !(await isOwnerOrSuper(request, propertyId))) throw redirect("/admin");
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const email = String(form.get("email") || "").trim().toLowerCase();

  if (intent === "invite" && email) {
    await addPropertyMember(propertyId, email);
    // Pre-create the user so they can sign in (even once sign-up is locked down)
    // and show up in the superadmin Users list. Under a white-label partner the
    // invite carries the property's partner, so the new user is scoped (and
    // branded) as the partner's from their very first sign-in — but an EXISTING
    // user's affiliation is never rewritten by a mere team invite.
    const partnerId = (await getProperty(propertyId))?.partnerId;
    const existing = await getUser(email);
    if (!existing && partnerId) await setUserPartner(email, partnerId);
    else await upsertUser(email);
    // Let them know they've been added. The link lands on the sign-in page with
    // their email pre-filled; they request a fresh magic link there.
    const origin = new URL(request.url).origin;
    const signInUrl = `${origin}/admin/login?email=${encodeURIComponent(email)}`;
    await sendTeamInviteEmail(propertyId, email, inviter, signInUrl, partnerId);
  } else if (intent === "remove" && email) {
    await removePropertyMember(propertyId, email);
  } else if (intent === "access" && email) {
    // Checkboxes carry what the member CAN see; we store the complement so
    // absent-entry = full access stays the default for existing teams.
    const allowed = form.getAll("areas").map(String).filter(isMemberArea);
    const hidden: MemberArea[] = MEMBER_AREAS.filter((a) => !allowed.includes(a));
    await setMemberHiddenAreas(propertyId, email, hidden);
  }
  return redirect("/admin/team");
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "navTeam" });
}

export default function AdminTeam({ loaderData }: Route.ComponentProps) {
  const { name, owner, members, memberHiddenAreas } = loaderData;
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const t = useAdminT();
  const areaLabel: Record<MemberArea, string> = {
    operations: t("tmAreaOperations"),
    pricing: t("tmAreaPricing"),
    website: t("tmAreaWebsite"),
    emails: t("tmAreaEmails"),
    payments: t("tmAreaPayments"),
  };

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">{t("tmTitle")}</h1>
      <p className="mb-6 text-[14px] text-muted">
        {t("tmIntroPre")} <strong>{name || t("tmThisProperty")}</strong>
        {t("tmIntroPost")}
      </p>

      <div className="mb-7 overflow-hidden rounded-[14px] border border-line bg-surface">
        {/* owner */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="font-semibold">{owner ?? <span className="italic text-faint">{t("tmUnassigned")}</span>}</span>
            <span className="rounded-full bg-[#e8f0e6] px-2 py-0.5 text-[11px] font-semibold text-[#3f7a52]">
              {t("tmOwner")}
            </span>
          </div>
        </div>

        {/* teammates */}
        {members.map((m) => {
          const hidden = memberHiddenAreas[m] ?? [];
          return (
            <div key={m} className="border-t border-divider px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="font-semibold">{m}</span>
                <Form
                  method="post"
                  onSubmit={(e) => {
                    if (!confirm(t("tmRemoveConfirm", { email: m }))) e.preventDefault();
                  }}
                >
                  <input type="hidden" name="intent" value="remove" />
                  <input type="hidden" name="email" value={m} />
                  <button type="submit" className="text-[13px] font-semibold text-[#c0392b] hover:underline">
                    {t("tmRemove")}
                  </button>
                </Form>
              </div>
              {/* Per-member page access: ticked = can see that area. */}
              <Form method="post" className="mt-3">
                <input type="hidden" name="intent" value="access" />
                <input type="hidden" name="email" value={m} />
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">
                    {t("tmAccessTitle")}
                  </span>
                  {MEMBER_AREAS.map((a) => (
                    <label key={a} className="flex items-center gap-1.5 text-[13px] text-secondary">
                      <input type="checkbox" name="areas" value={a} defaultChecked={!hidden.includes(a)} />
                      {areaLabel[a]}
                    </label>
                  ))}
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-[8px] border border-line-alt px-2.5 py-1 text-[12px] font-semibold hover:border-accent hover:text-accent disabled:opacity-60"
                  >
                    {t("tmAccessSave")}
                  </button>
                </div>
                <p className="mt-1 text-[12px] text-faint">{t("tmAccessHint")}</p>
              </Form>
            </div>
          );
        })}

        {members.length === 0 && (
          <div className="border-t border-divider px-5 py-4 text-[13px] text-muted">
            {t("tmNoTeammates")}
          </div>
        )}
      </div>

      {/* invite */}
      <Form method="post" className="flex flex-col gap-4 rounded-[14px] border border-line bg-surface p-6">
        <input type="hidden" name="intent" value="invite" />
        <h2 className="font-serif text-[18px] font-semibold">{t("tmInviteTitle")}</h2>
        <label className="block text-[13px] font-semibold text-secondary">
          {t("tmEmailLabel")}
          <input
            name="email"
            type="email"
            required
            placeholder={t("tmEmailPlaceholder")}
            className={FIELD_INPUT}
          />
          <span className="mt-1 block text-[11px] font-normal text-faint">
            {t("tmInviteHint")}
          </span>
        </label>
        <div>
          <button
            type="submit"
            disabled={busy}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {busy ? t("tmInviting") : t("tmInvite")}
          </button>
        </div>
      </Form>
    </div>
  );
}
