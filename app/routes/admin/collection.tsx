import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/collection";
import { adminMeta } from "~/lib/page-meta";
import { FIELD_INPUT } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import {
  deleteCollection,
  getVisibleCollections,
  updateCollection,
} from "~/lib/collections.server";
import { getConfig } from "~/lib/config.server";
import { FONT_PAIRS, isThemeId, THEMES } from "~/lib/content";
import { getVisibleProperties } from "~/lib/properties.server";
import { propertyActivity } from "~/lib/property-activity.server";
import { browseDirectory, type DirectoryEntry } from "~/lib/collection-directory.server";
import { sendCollectionMembershipEmail } from "~/lib/email.server";
import { getProperty } from "~/lib/properties.server";
import {
  addMemberByCollection,
  endMembership,
  resolveMembership,
  type MembershipMode,
} from "~/lib/collections.server";
import { activityLevel, type PropertyActivity } from "~/lib/property-activity";
import { getOverrides, getSettings } from "~/lib/overrides.server";
import { useAdminT } from "~/lib/admin-i18n";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const collection = (await getVisibleCollections(request)).find((c) => c.slug === params.slug);
  if (!collection) throw redirect("/admin/collections");

  // The properties this user can add to the collection, with the name + whether
  // each has map coordinates (needed for the map pins on the public page).
  const props = await getVisibleProperties(request);
  // Whether each property is actually trading, so a dormant one doesn't get
  // added and then show "no availability" to every guest who clicks it.
  // Batched: one grouped query for the whole list, not one per row.
  const activity = await propertyActivity(props.map((p) => p.id));
  const properties = await Promise.all(
    props.map(async (p) => {
      const [ov, settings] = await Promise.all([getOverrides(p.id), getSettings(p.id)]);
      return {
        id: p.id,
        name: ov.hotelName || p.name,
        hasGeo: Boolean(settings.latitude && settings.longitude),
        activity: activity.get(p.id) ?? null,
      };
    }),
  );

  // Members the operator does NOT own. They can't appear as checkboxes above
  // (that list is scoped to the operator's own properties), so they get their
  // own read-only list — and the action must be careful not to drop them.
  const ownIds = new Set(props.map((p) => p.id));
  const externalIds = collection.members
    .filter((m) => m.status !== "left" && m.status !== "declined" && !ownIds.has(m.propertyId))
    .map((m) => m.propertyId);
  const externalActivity = await propertyActivity(externalIds);
  const external = await Promise.all(
    externalIds.map(async (id) => {
      // The display name can live in either place: an override if the owner has
      // set one, otherwise the registry. Falling back to the id alone showed a
      // raw UUID for any property without an override.
      const [ov, ref] = await Promise.all([getOverrides(id), getProperty(id)]);
      const member = collection.members.find((m) => m.propertyId === id)!;
      return {
        id,
        name: ov.hotelName || ref?.name || id,
        status: member.status,
        initiatedBy: member.initiatedBy,
        activity: externalActivity.get(id) ?? null,
      };
    }),
  );

  // The directory is only meaningful once a collection accepts outsiders.
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const directory =
    collection.membershipMode === "private"
      ? []
      : await browseDirectory({
          q,
          // Own properties are already offered as checkboxes above. Of the rest,
          // hide current and waiting members, and ones that have DECLINED — but
          // keep showing a property that merely left, because `addMemberByCollection`
          // allows re-adding it and hiding it here would make that unreachable.
          exclude: new Set([
            ...ownIds,
            ...collection.members.filter((m) => m.status !== "left").map((m) => m.propertyId),
          ]),
        });

  const appUrl = getConfig().appUrl.replace(/\/+$/, "");
  return { collection, properties, external, directory, q, appUrl };
}

const MODES: MembershipMode[] = ["private", "official", "curated", "open"];
const modeOf = (v: FormDataEntryValue | null): MembershipMode =>
  MODES.includes(String(v) as MembershipMode) ? (String(v) as MembershipMode) : "private";

/** Tells a property what just happened to its listing. Best-effort: an add must
 *  not fail because mail is down, but it must be ATTEMPTED — an immediate add is
 *  only fair if the property finds out about it. Ownerless properties (legacy /
 *  unclaimed) have no account to write to, so they're skipped and logged. */
async function notifyProperty(
  propertyId: string,
  kind: "added" | "invited" | "approved" | "declined",
  collection: { name: string; slug: string },
): Promise<void> {
  try {
    const prop = await getProperty(propertyId);
    if (!prop?.owner) {
      console.log(`[collections] no owner for ${propertyId}; skipping ${kind} notice`);
      return;
    }
    const appUrl = getConfig().appUrl.replace(/\/+$/, "");
    const ov = await getOverrides(propertyId);
    await sendCollectionMembershipEmail({
      pid: propertyId,
      to: prop.owner,
      kind,
      propertyName: ov.hotelName || prop.name,
      collectionName: collection.name,
      collectionUrl: `${appUrl}/c/${collection.slug}`,
      manageUrl: `${appUrl}/admin/collections`,
    });
  } catch (e) {
    console.log(`[collections] ${kind} notice failed for ${propertyId}: ${e instanceof Error ? e.message : e}`);
  }
}

/** Active members outside the operator's own properties. The save form can't
 *  represent them, so they're re-added to the reconciled list rather than being
 *  silently dropped. */
async function externalActiveIds(request: Request, slug: string): Promise<string[]> {
  const c = (await getVisibleCollections(request)).find((x) => x.slug === slug);
  if (!c) return [];
  const ownIds = new Set((await getVisibleProperties(request)).map((p) => p.id));
  return c.members.filter((m) => m.status === "active" && !ownIds.has(m.propertyId)).map((m) => m.propertyId);
}

export async function action({ params, request }: Route.ActionArgs) {
  await requireAdmin(request);
  // Ownership: must be one of the user's visible collections.
  const owned = (await getVisibleCollections(request)).some((c) => c.slug === params.slug);
  if (!owned) throw redirect("/admin/collections");

  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "delete") {
    await deleteCollection(params.slug);
    return redirect("/admin/collections");
  }

  if (intent === "addMember") {
    const propertyId = String(form.get("propertyId") || "");
    const res = await addMemberByCollection(params.slug, propertyId);
    if ("error" in res) return { errorKey: `coAddErr_${res.error}` as const };
    const c = (await getVisibleCollections(request)).find((x) => x.slug === params.slug);
    if (c) await notifyProperty(propertyId, res.status === "invited" ? "invited" : "added", c);
    return { okKey: `coAdded_${res.status}` as const };
  }
  if (intent === "removeMember") {
    await endMembership(params.slug, String(form.get("propertyId") || ""));
    return { okKey: "coRemoved" as const };
  }
  if (intent === "approveRequest" || intent === "declineRequest") {
    const propertyId = String(form.get("propertyId") || "");
    const approved = intent === "approveRequest";
    if (await resolveMembership(params.slug, propertyId, approved)) {
      const c = (await getVisibleCollections(request)).find((x) => x.slug === params.slug);
      if (c) await notifyProperty(propertyId, approved ? "approved" : "declined", c);
    }
    return { okKey: "coRequestResolved" as const };
  }

  const themeRaw = String(form.get("theme") || "").trim();
  const res = await updateCollection(params.slug, {
    name: String(form.get("name") || ""),
    slug: String(form.get("slug") || ""),
    destination: String(form.get("destination") || ""),
    heading: String(form.get("heading") || ""),
    intro: String(form.get("intro") || ""),
    phone: String(form.get("phone") || ""),
    membershipMode: modeOf(form.get("membershipMode")),
    // The checkbox list only offers the operator's OWN properties, so a plain
    // save would mark every external member as having left. Carry them through.
    propertyIds: [
      ...form.getAll("propertyIds").map(String),
      ...(await externalActiveIds(request, params.slug)),
    ],
    theme: themeRaw === "custom" || isThemeId(themeRaw) ? (themeRaw as never) : undefined,
    customColor: String(form.get("customColor") || ""),
    customBg: String(form.get("customBg") || ""),
    themeFont: String(form.get("themeFont") || ""),
  });
  if ("error" in res) return { error: res.error };
  // Slug may have changed → land on the (possibly new) editor URL.
  return redirect(`/admin/collections/${res.collection.slug}`);
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "mtEditCollection" });
}

/** How much of the coming year a property has rooms for sale, and whether
 *  anyone is still maintaining it. A low percentage is shown plainly rather than
 *  warned about — a hotel that closes for the winter is seasonal, not dead, and
 *  a destination collection wants it. Only the two unambiguous problems get a
 *  flag: never connected, and untouched for months. */
function Trading({ activity }: { activity: PropertyActivity | null }) {
  const t = useAdminT();
  if (!activity) return null;
  const level = activityLevel(activity, Date.now());
  if (level === "unknown") {
    return (
      <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-muted" title={t("coTradingUnknownHelp")}>
        {t("coTradingUnknown")}
      </span>
    );
  }
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        level === "stale" ? "bg-amber-100 text-amber-800" : "bg-chip text-secondary"
      }`}
      title={level === "stale" ? t("coTradingStaleHelp") : t("coTradingOpenHelp")}
    >
      {t("coTradingOpen", { pct: String(activity.openPct) })}
      {level === "stale" ? ` · ${t("coTradingStale")}` : ""}
    </span>
  );
}

export default function AdminCollection({ loaderData, actionData }: Route.ComponentProps) {
  const { collection: c, properties, external, directory, q, appUrl } = loaderData;
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const host = appUrl.replace(/^https?:\/\//, "");
  const selected = new Set(c.propertyIds);
  const t = useAdminT();

  return (
    <div className="max-w-[720px]">
      <div className="mb-4">
        <Link to="/admin/collections" className="text-[13px] font-semibold text-muted hover:text-accent">
          {t("coBackAll")}
        </Link>
      </div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-[26px] font-semibold">{c.name}</h1>
        <div className="flex items-center gap-2">
          <Link
            to={`/admin/collections/${c.slug}/analytics`}
            className="rounded-[10px] border border-line-alt bg-surface-alt px-[16px] py-[9px] text-[13px] font-semibold text-secondary hover:border-accent hover:text-accent"
          >
            {t("caTitle")}
          </Link>
          <Link
            to={`/c/${c.slug}`}
            target="_blank"
            className="rounded-[10px] border border-line-alt bg-surface-alt px-[16px] py-[9px] text-[13px] font-semibold text-secondary hover:border-accent hover:text-accent"
          >
            {t("coViewPage")}
          </Link>
        </div>
      </div>

      <Form method="post" className="flex flex-col gap-6">
        <input type="hidden" name="intent" value="save" />

        {/* Identity */}
        <section className="rounded-[14px] border border-line bg-surface p-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-[13px] font-semibold text-secondary">
              {t("coName")}
              <input name="name" defaultValue={c.name} className={FIELD_INPUT} />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              {t("coLink")}
              <div className="mt-1.5 flex items-center rounded-[10px] border border-line-alt bg-surface-alt pl-3.5">
                <span className="text-[13px] text-muted-2">{host}/c/</span>
                <input
                  name="slug"
                  defaultValue={c.slug}
                  className="min-w-0 flex-1 bg-transparent px-1 py-[11px] text-[15px] text-ink outline-none"
                />
              </div>
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              {t("coDestination")} <span className="font-normal text-faint">{t("coEyebrowNote")}</span>
              <input name="destination" defaultValue={c.destination} placeholder="Dublin" className={FIELD_INPUT} />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              {t("coPhone")} <span className="font-normal text-faint">{t("coHeaderNote")}</span>
              <input name="phone" defaultValue={c.phone} placeholder="+353 1 555 0192" className={FIELD_INPUT} />
            </label>
          </div>
          <label className="mt-4 block text-[13px] font-semibold text-secondary">
            {t("coHeadline")}
            <input
              name="heading"
              defaultValue={c.heading}
              placeholder="Choose where you'll stay"
              className={FIELD_INPUT}
            />
            <span className="mt-1 block text-[11px] font-normal text-faint">
              {t("coHeadlineHint")}
            </span>
          </label>
          <label className="mt-4 block text-[13px] font-semibold text-secondary">
            {t("coIntroLabel")}
            <textarea
              name="intro"
              defaultValue={c.intro}
              rows={2}
              placeholder="Hotels, guesthouses and self-catering homes across the city — all bookable direct, with no booking fees."
              className={`${FIELD_INPUT} resize-y`}
            />
          </label>
        </section>

        {/* Properties */}
        <section className="rounded-[14px] border border-line bg-surface p-6">
          <div className="mb-1 font-serif text-[18px] font-semibold">{t("coPropertiesTitle")}</div>
          <label className="mb-5 block text-[13px] font-semibold text-secondary">
            {t("coModeLabel")}
            <select
              name="membershipMode"
              defaultValue={c.membershipMode}
              className="mt-1 block w-full max-w-[420px] rounded-[9px] border border-line-alt bg-surface px-3 py-2 text-[14px] font-normal"
            >
              {(["private", "official", "curated", "open"] as const).map((m) => (
                <option key={m} value={m}>{t(`coMode_${m}`)}</option>
              ))}
            </select>
            <span className="mt-1 block text-[12px] font-normal text-muted">{t(`coModeHelp_${c.membershipMode}`)}</span>
          </label>

          <p className="mb-4 text-[13px] text-muted">
            {t("coPropertiesIntroBefore")}{" "}
            <Link to="/admin/general" className="font-semibold text-accent hover:underline">{t("coPropertiesIntroLink")}</Link>
            {t("coPropertiesIntroAfter")}
          </p>
          {properties.length === 0 ? (
            <p className="text-[13.5px] text-muted">{t("coNoProperties")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {properties.map((p) => (
                <label
                  key={p.id}
                  className="flex cursor-pointer items-center gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3"
                >
                  <input
                    type="checkbox"
                    name="propertyIds"
                    value={p.id}
                    defaultChecked={selected.has(p.id)}
                  />
                  <span className="flex-1 text-[14px] font-semibold text-ink">{p.name}</span>
                  <Trading activity={p.activity} />
                  {!p.hasGeo && (
                    <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-muted">
                      {t("coNoMapPin")}
                    </span>
                  )}
                </label>
              ))}
            </div>
          )}
        </section>

        {/* Theme */}
        <section className="rounded-[14px] border border-line bg-surface p-6">
          <div className="mb-3 font-serif text-[18px] font-semibold">{t("coThemeTitle")}</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="block text-[13px] font-semibold text-secondary">
              {t("coColourTheme")}
              <select name="theme" defaultValue={c.theme ?? "terracotta"} className={FIELD_INPUT}>
                {THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
                <option value="custom">{t("coCustomOption")}</option>
              </select>
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              {t("coCustomAccent")}
              <input name="customColor" defaultValue={c.customColor} placeholder="#b5651d" className={FIELD_INPUT} />
            </label>
            <label className="block text-[13px] font-semibold text-secondary">
              {t("coCustomBg")}
              <input name="customBg" defaultValue={c.customBg} placeholder="#f7f2ec" className={FIELD_INPUT} />
            </label>
          </div>
          <label className="mt-4 block max-w-sm text-[13px] font-semibold text-secondary">
            {t("coFonts")}
            <select name="themeFont" defaultValue={c.themeFont ?? "default"} className={FIELD_INPUT}>
              {FONT_PAIRS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
        </section>

        {actionData?.error && <p className="text-[13px] text-red-600">{actionData.error}</p>}

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? t("saving") : t("coSave")}
          </button>
        </div>
      </Form>

      {/* Membership beyond the operator's own properties. Kept outside the save
          form: these are immediate actions, and nesting them would make the
          hidden save intent win over each button's own. */}
      {c.membershipMode !== "private" && (
        <section className="mt-6 rounded-[14px] border border-line bg-surface p-6">
          <h2 className="font-serif text-[19px] font-semibold">{t("coMembersTitle")}</h2>
          <p className="mt-1 text-[13px] text-muted">{t(`coModeHelp_${c.membershipMode}`)}</p>

          {external.length > 0 && (
            <div className="mt-4 flex flex-col gap-2">
              {external.map((m) => (
                <div key={m.id} className="flex flex-wrap items-center gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3">
                  <span className="flex-1 text-[14px] font-semibold text-ink">{m.name}</span>
                  <Trading activity={m.activity} />
                  {m.status !== "active" && (
                    <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-muted">
                      {t(`coStatus_${m.status}`)}
                    </span>
                  )}
                  {m.status === "requested" ? (
                    // Two distinct intents rather than one intent plus a hidden
                    // accept flag: a submit button's own name/value is the only
                    // thing that reliably says which button was pressed.
                    <Form method="post" className="flex gap-2">
                      <input type="hidden" name="propertyId" value={m.id} />
                      <button type="submit" name="intent" value="approveRequest" className="rounded-[9px] bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-white">
                        {t("coApprove")}
                      </button>
                      <button type="submit" name="intent" value="declineRequest" className="rounded-[9px] border border-line-alt px-3 py-1.5 text-[12.5px] font-semibold text-secondary hover:border-accent">
                        {t("coDecline")}
                      </button>
                    </Form>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="propertyId" value={m.id} />
                      <button type="submit" name="intent" value="removeMember" className="text-[12.5px] font-semibold text-[#c0392b] hover:underline">
                        {t("coRemoveMember")}
                      </button>
                    </Form>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Search is a GET so a result list can be linked and reloaded. */}
          <Form method="get" className="mt-5 flex flex-wrap gap-2">
            <input
              name="q"
              defaultValue={q}
              placeholder={t("coDirSearchPlaceholder")}
              className="min-w-[260px] flex-1 rounded-[9px] border border-line-alt bg-surface px-3 py-2 text-[14px]"
            />
            <button type="submit" className="rounded-[9px] border border-line-alt bg-surface px-4 py-2 text-[13px] font-semibold text-secondary hover:border-accent hover:text-accent">
              {t("coDirSearch")}
            </button>
          </Form>

          {directory.length === 0 ? (
            <p className="mt-4 text-[13px] text-muted">{t("coDirNone")}</p>
          ) : (
            <div className="mt-4 flex flex-col gap-2">
              {directory.map((d: DirectoryEntry) => (
                <div key={d.id} className="flex flex-wrap items-center gap-3 rounded-[10px] border border-line-alt px-4 py-3">
                  <span className="text-[14px] font-semibold text-ink">{d.name}</span>
                  {d.location && <span className="text-[12.5px] text-muted">{d.location}</span>}
                  {d.propertyType && (
                    <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-muted">{d.propertyType}</span>
                  )}
                  <span className="flex-1" />
                  <Trading activity={d.activity} />
                  <Form method="post">
                    <input type="hidden" name="propertyId" value={d.id} />
                    <button type="submit" name="intent" value="addMember" className="rounded-[9px] bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-white">
                      {c.membershipMode === "official" ? t("coInvite") : t("coAdd")}
                    </button>
                  </Form>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <Form
        method="post"
        className="mt-8 border-t border-divider pt-6"
        onSubmit={(e) => {
          if (!confirm(t("coDeleteConfirm", { name: c.name }))) e.preventDefault();
        }}
      >
        <input type="hidden" name="intent" value="delete" />
        <button type="submit" className="text-[13px] font-semibold text-[#c0392b] hover:underline">
          {t("coDeleteThis")}
        </button>
      </Form>
    </div>
  );
}
