import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/properties";
import { FIELD_INPUT } from "~/components/admin-form";
import { useAdminT } from "~/lib/admin-i18n";
import { requireAdmin, setSessionProperty } from "~/lib/auth.server";
import {
  addProperty,
  canAccess,
  currentPropertyId,
  getVisibleProperties,
  isOwnerOrSuper,
  removeProperty,
  renameProperty,
  setPropertyOwner,
  setPropertyPublic,
} from "~/lib/properties.server";
import { cloneProperty } from "~/lib/clone-property.server";
import { getUsers, isSuperadmin } from "~/lib/users.server";

export async function loader({ request }: Route.LoaderArgs) {
  const email = await requireAdmin(request);
  const su = await isSuperadmin(email);
  const [properties, current, users] = await Promise.all([
    getVisibleProperties(request),
    currentPropertyId(request),
    su ? getUsers() : Promise.resolve([]),
  ]);
  // Per-row: can this user manage (rename/delete/transfer/public) the property,
  // or are they just a teammate who can edit its content?
  const rows = properties.map((p) => ({ ...p, canManage: su || p.owner === email }));
  return { properties: rows, current, isSuperadmin: su, userEmails: users.map((u) => u.email) };
}

export async function action({ request }: Route.ActionArgs) {
  const email = await requireAdmin(request);
  const su = await isSuperadmin(email);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "add") {
    const name = String(form.get("name") || "").trim();
    const id = String(form.get("id") || "").trim() || crypto.randomUUID();
    // New properties are owned by the user who created them.
    await addProperty(id, name, email);
    // Switch to the new property so editing continues there.
    return redirect("/admin", { headers: { "Set-Cookie": await setSessionProperty(request, id) } });
  }

  const id = String(form.get("id") || "");

  // Reassigning ownership is superadmin-only.
  if (intent === "reassign") {
    if (su) await setPropertyOwner(id, String(form.get("owner") || "") || undefined);
    return redirect("/admin/properties");
  }

  // Switching the active property only needs access (teammates included).
  if (intent === "switch") {
    if (await canAccess(request, id)) {
      return redirect("/admin", {
        headers: { "Set-Cookie": await setSessionProperty(request, id) },
      });
    }
    return redirect("/admin/properties");
  }

  // Destructive / structural changes require ownership (or superadmin) — a
  // teammate must not delete, rename, or change the public state of a property.
  if (!(await isOwnerOrSuper(request, id))) return redirect("/admin/properties");

  if (intent === "clone") {
    // Copy of a property's content (rooms, rates, texts, taxes, extras…) under
    // a fresh id — e.g. one clone per apartment for Google Vacation Rentals.
    // Connections (Channex, Google push), slug and public state are NOT copied.
    const newId = await cloneProperty(id, email);
    // Switch to the clone so the host can rename it and prune rooms right away.
    return redirect("/admin", { headers: { "Set-Cookie": await setSessionProperty(request, newId) } });
  }

  if (intent === "rename") {
    await renameProperty(id, String(form.get("name") || ""));
  } else if (intent === "delete") {
    await removeProperty(id);
  } else if (intent === "togglePublic") {
    await setPropertyPublic(id, form.get("public") === "on");
  }
  return redirect("/admin/properties");
}

export function meta() {
  return [{ title: "Admin · Properties" }];
}

export default function AdminProperties({ loaderData }: Route.ComponentProps) {
  const { properties, current, isSuperadmin: su, userEmails } = loaderData;
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const t = useAdminT();

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">{t("prsTitle")}</h1>
      <p className="mb-6 text-[14px] text-muted">
        {t("prsIntroPre")} <strong>{t("prsPublic")}</strong>
        {t("prsIntroPost")}
        {su && t("prsIntroSuper")}
      </p>

      {properties.length === 0 && (
        <div className="mb-7 rounded-[14px] border border-dashed border-line bg-surface px-5 py-6 text-[14px] text-muted">
          {t("prsEmpty")}
        </div>
      )}

      {/* list */}
      {properties.length > 0 && (
        <div className="mb-7 overflow-hidden rounded-[14px] border border-line bg-surface">
          {properties.map((p, i) => (
            <div
              key={p.id}
              className={`flex flex-wrap items-center justify-between gap-3 px-5 py-4 ${
                i > 0 ? "border-t border-divider" : ""
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <span className="font-semibold">{p.name}</span>
                  {p.id === current && (
                    <span className="rounded-full bg-[#e8f0e6] px-2 py-0.5 text-[11px] font-semibold text-[#3f7a52]">
                      {t("prsEditing")}
                    </span>
                  )}
                  {!p.canManage && (
                    <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-muted">
                      {t("prsTeammate")}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 font-mono text-[12px] text-muted-2">{p.id}</div>
                {su && (
                  <div className="mt-0.5 text-[12px] text-muted">
                    {t("prsOwner")}: {p.owner ?? <span className="italic text-faint">{t("prsUnassigned")}</span>}
                    {p.members && p.members.length > 0 && (
                      <span className="text-muted-2">
                        {" "}· {t(p.members.length === 1 ? "prsTeammates_one" : "prsTeammates_other", { n: p.members.length })}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex flex-none items-center gap-3 text-[13px] font-semibold">
                {su && (
                  <Form method="post" className="flex items-center">
                    <input type="hidden" name="intent" value="reassign" />
                    <input type="hidden" name="id" value={p.id} />
                    <select
                      name="owner"
                      defaultValue={p.owner ?? ""}
                      onChange={(e) => e.currentTarget.form?.requestSubmit()}
                      aria-label={t("prsOwner")}
                      title={t("prsReassignOwner")}
                      className="cursor-pointer rounded-[8px] border border-line-alt bg-surface px-2 py-1 text-[12px] font-semibold text-ink outline-none focus:border-accent"
                    >
                      <option value="">{t("prsUnassignedOption")}</option>
                      {[...new Set([...userEmails, ...(p.owner ? [p.owner] : [])])].map((em) => (
                        <option key={em} value={em}>
                          {em}
                        </option>
                      ))}
                    </select>
                  </Form>
                )}
                {p.canManage ? (
                  <Form method="post" title={p.public ? t("prsListedTitle") : t("prsHiddenTitle")}>
                    <input type="hidden" name="intent" value="togglePublic" />
                    <input type="hidden" name="id" value={p.id} />
                    {/* flips the current value: send "on" only when turning it public */}
                    {!p.public && <input type="hidden" name="public" value="on" />}
                    <button
                      type="submit"
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                        p.public
                          ? "bg-[#e8f0e6] text-[#3f7a52] hover:bg-[#dbe8d8]"
                          : "bg-chip text-muted hover:bg-line"
                      }`}
                    >
                      {p.public ? t("prsPublic") : t("prsPrivate")}
                    </button>
                  </Form>
                ) : (
                  p.public && (
                    <span className="rounded-full bg-[#e8f0e6] px-2.5 py-0.5 text-[11px] font-semibold text-[#3f7a52]">
                      {t("prsPublic")}
                    </span>
                  )
                )}
                <Link to={`/${p.slug || p.id}`} target="_blank" className="text-muted hover:text-accent">
                  {t("prsView")}
                </Link>
                {p.id !== current && (
                  // reloadDocument: this sets the property cookie + redirects, so
                  // the whole admin must re-render from fresh SSR under the new
                  // property — a SPA navigation races the Set-Cookie against the
                  // loader fetch and leaves the header switcher (and any loader
                  // data) on the OLD property. Same fix as the header switcher.
                  <Form method="post" reloadDocument>
                    <input type="hidden" name="intent" value="switch" />
                    <input type="hidden" name="id" value={p.id} />
                    <button type="submit" className="text-accent hover:underline">
                      {t("prsEdit")}
                    </button>
                  </Form>
                )}
                {p.canManage && (
                  // reloadDocument: cloning switches the session to the new
                  // property (see the Edit button above for why SPA nav is unsafe).
                  <Form
                    method="post"
                    reloadDocument
                    onSubmit={(e) => {
                      if (!confirm(t("prsCloneConfirm", { name: p.name }))) e.preventDefault();
                    }}
                  >
                    <input type="hidden" name="intent" value="clone" />
                    <input type="hidden" name="id" value={p.id} />
                    <button type="submit" disabled={saving} className="hover:text-accent hover:underline disabled:opacity-60">
                      {t("prsClone")}
                    </button>
                  </Form>
                )}
                {p.canManage && properties.length > 1 && (
                  <Form
                    method="post"
                    onSubmit={(e) => {
                      if (!confirm(t("prsRemoveConfirm", { name: p.name }))) e.preventDefault();
                    }}
                  >
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="id" value={p.id} />
                    <button type="submit" className="text-[#c0392b] hover:underline">
                      {t("prsRemove")}
                    </button>
                  </Form>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Onboard from Channex — pull details/rooms/rates from a Channex account. */}
      <Link
        to="/admin/properties/onboard"
        className="mb-4 flex items-center justify-between gap-3 rounded-[14px] border border-line bg-surface px-6 py-5 hover:border-accent"
      >
        <span>
          <span className="block font-serif text-[18px] font-semibold">{t("prsOnboardTitle")}</span>
          <span className="block text-[13px] text-muted">
            {t("prsOnboardDesc")}
          </span>
        </span>
        <span className="flex-none text-[15px] font-semibold text-accent">{t("prsStart")}</span>
      </Link>

      {/* add — reloadDocument: creating switches the session to the new property
          (see the Edit button above for why SPA nav is unsafe here). */}
      <Form method="post" reloadDocument className="flex flex-col gap-4 rounded-[14px] border border-line bg-surface p-6">
        <input type="hidden" name="intent" value="add" />
        <h2 className="font-serif text-[18px] font-semibold">{t("prsAddTitle")}</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block text-[13px] font-semibold text-secondary">
            {t("prsName")}
            <input name="name" placeholder={t("prsNamePlaceholder")} className={FIELD_INPUT} />
          </label>
          <label className="block text-[13px] font-semibold text-secondary">
            {t("prsId")} <span className="font-normal text-faint">{t("prsOptional")}</span>
            <input name="id" placeholder={t("prsIdPlaceholder")} className={`${FIELD_INPUT} font-mono`} />
            <span className="mt-1 block text-[11px] font-normal text-faint">
              {t("prsIdHint")}
            </span>
          </label>
        </div>
        <div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? t("prsAdding") : t("prsAdd")}
          </button>
        </div>
      </Form>
    </div>
  );
}
