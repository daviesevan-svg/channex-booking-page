import { Form, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/users";
import { useAdminLang, useAdminT } from "~/lib/admin-i18n";
import { requireSuperadmin } from "~/lib/auth.server";
import { getProperties } from "~/lib/properties.server";
import { getUsers, isEnvSuperadmin, removeUser, setUserRole, upsertUser } from "~/lib/users.server";

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireSuperadmin(request);
  let [users, properties] = await Promise.all([getUsers(), getProperties()]);
  // Reconcile: anyone referenced as a property owner or teammate must have a
  // user record, so a record lost to an earlier bug (or an owner set outside the
  // normal sign-in flow) still appears here and can be managed.
  const known = new Set(users.map((u) => u.email));
  const referenced = new Set<string>();
  for (const p of properties) {
    if (p.owner) referenced.add(p.owner.toLowerCase());
    for (const m of p.members ?? []) referenced.add(m.toLowerCase());
  }
  const missing = [...referenced].filter((e) => !known.has(e));
  if (missing.length) {
    await Promise.all(missing.map((e) => upsertUser(e)));
    users = await getUsers();
  }
  // property count per owner
  const counts: Record<string, number> = {};
  for (const p of properties) if (p.owner) counts[p.owner] = (counts[p.owner] ?? 0) + 1;
  const rows = users
    .map((u) => {
      const envLocked = isEnvSuperadmin(u.email);
      return {
        ...u,
        properties: counts[u.email] ?? 0,
        envLocked,
        // Effective status: env list overrides the stored record.
        superadmin: envLocked || u.role === "superadmin",
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));
  return { me, rows };
}

export async function action({ request }: Route.ActionArgs) {
  const me = await requireSuperadmin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const email = String(form.get("email") || "").trim().toLowerCase();

  // Guard against self-lockout: you can't change your own role, and an
  // env-listed superadmin's role is fixed (set via SUPERADMIN_EMAILS).
  if (intent === "setRole") {
    const role = form.get("role") === "superadmin" ? "superadmin" : "member";
    if (email && email !== me && !isEnvSuperadmin(email)) {
      await setUserRole(email, role);
    }
    return redirect("/admin/users");
  }
  if (intent === "delete") {
    if (email && email !== me && !isEnvSuperadmin(email)) {
      await removeUser(email);
    }
    return redirect("/admin/users");
  }
  return redirect("/admin/users");
}

export function meta() {
  return [{ title: "Admin · Users" }];
}

function fmtDate(ms: number, lang: string): string {
  try {
    return new Date(ms).toLocaleDateString(lang, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export default function AdminUsers({ loaderData }: Route.ComponentProps) {
  const { me, rows } = loaderData;
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const t = useAdminT();
  const lang = useAdminLang();

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">{t("usTitle")}</h1>
      <p className="mb-6 text-[14px] text-muted">
        {t("usIntroPre")}{" "}
        <code className="rounded bg-chip px-1 py-0.5 text-[12px]">ADMIN_EMAILS</code>.
      </p>

      <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
        {rows.length === 0 && (
          <div className="px-5 py-6 text-[14px] text-muted">{t("usEmpty")}</div>
        )}
        {rows.map((u, i) => (
          <div
            key={u.email}
            className={`flex flex-wrap items-center justify-between gap-3 px-5 py-4 ${
              i > 0 ? "border-t border-divider" : ""
            }`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <span className="font-semibold">{u.email}</span>
                {u.email === me && (
                  <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-muted">
                    {t("usYou")}
                  </span>
                )}
                {u.superadmin && (
                  <span className="rounded-full bg-[#ece6f0] px-2 py-0.5 text-[11px] font-semibold text-[#6b4f8a]">
                    {t("usSuperadmin")}{u.envLocked ? " · env" : ""}
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-[12px] text-muted-2">
                {t(u.properties === 1 ? "usPropsJoined_one" : "usPropsJoined_other", {
                  n: u.properties,
                  date: fmtDate(u.createdAt, lang),
                })}
              </div>
            </div>

            <div className="flex flex-none items-center gap-3 text-[13px] font-semibold">
              {/* role toggle — disabled for yourself and env-locked superadmins */}
              {u.email !== me && !u.envLocked ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="setRole" />
                  <input type="hidden" name="email" value={u.email} />
                  <input
                    type="hidden"
                    name="role"
                    value={u.superadmin ? "member" : "superadmin"}
                  />
                  <button type="submit" disabled={busy} className="text-accent hover:underline disabled:opacity-50">
                    {u.superadmin ? t("usMakeMember") : t("usMakeSuperadmin")}
                  </button>
                </Form>
              ) : (
                <span className="text-faint">{t("usRoleLocked")}</span>
              )}

              {u.email !== me && !u.envLocked && (
                <Form
                  method="post"
                  onSubmit={(e) => {
                    if (!confirm(t("usRemoveConfirm", { email: u.email }))) e.preventDefault();
                  }}
                >
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="email" value={u.email} />
                  <button type="submit" className="text-[#c0392b] hover:underline">
                    {t("usRemove")}
                  </button>
                </Form>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
