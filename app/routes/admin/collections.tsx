import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/collections";
import { adminMeta } from "~/lib/page-meta";
import { FIELD_INPUT } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import {
  canAccessCollection,
  createCollection,
  deleteCollection,
  collectionOperatorEmails,
  endMembership,
  getCollectionBySlug,
  getVisibleCollections,
  joinableCollections,
  membershipsForProperties,
  requestToJoin,
  resolveMembership,
} from "~/lib/collections.server";
import { getConfig } from "~/lib/config.server";
import { getOverrides, getSettings } from "~/lib/overrides.server";
import { sendCollectionRequestEmail } from "~/lib/email.server";
import { getVisibleProperties } from "~/lib/properties.server";
import { useAdminT } from "~/lib/admin-i18n";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const collections = await getVisibleCollections(request);

  // The other side of the relationship: collections that list one of YOUR
  // properties. An operator may add a property without asking, so the property
  // has to be able to see where it appears and take itself out — otherwise
  // "immediate add" is a one-way door.
  const mine = await getVisibleProperties(request);
  const myIds = new Set(mine.map((p) => p.id));
  const operated = new Set(collections.map((c) => c.slug));
  const names = new Map(
    await Promise.all(mine.map(async (p) => [p.id, (await getOverrides(p.id)).hotelName || p.name] as const)),
  );
  const listings = (await membershipsForProperties([...myIds]))
    // Your own collections are managed above; don't show them twice.
    .filter((m) => !operated.has(m.collection.slug))
    .map((m) => ({
      slug: m.collection.slug,
      collectionName: m.collection.name,
      propertyId: m.member.propertyId,
      propertyName: names.get(m.member.propertyId) ?? m.member.propertyId,
      status: m.member.status,
    }));

  // Collections your properties could ask to join. Only curated and open accept
  // requests, so invite-only ones aren't offered — a button that always fails is
  // worse than no button.
  const joinable = (await joinableCollections([...myIds], operated)).map((j) => ({
    ...j,
    options: j.eligiblePropertyIds.map((id) => ({ id, name: names.get(id) ?? id })),
  }));

  const appUrl = getConfig().appUrl.replace(/\/+$/, "");
  return { collections, listings, joinable, appUrl };
}

export async function action({ request }: Route.ActionArgs) {
  const email = await requireAdmin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "add") {
    const name = String(form.get("name") || "").trim();
    if (!name) return { error: "Give your collection a name." };
    const col = await createCollection(name, email);
    return redirect(`/admin/collections/${col.slug}`);
  }

  if (intent === "delete") {
    const slug = String(form.get("slug") || "");
    if (await canAccessCollection(request, slug)) await deleteCollection(slug);
    return redirect("/admin/collections");
  }

  if (intent === "requestJoin") {
    const slug = String(form.get("slug") || "");
    const propertyId = String(form.get("propertyId") || "");
    const mine = (await getVisibleProperties(request)).find((p) => p.id === propertyId);
    if (!mine) return redirect("/admin/collections");
    const res = await requestToJoin(slug, propertyId);
    if ("error" in res) return { error: null, requestErrorKey: `coReqErr_${res.error}` as const };
    // Only a pending request needs the operator's attention; an `open` collection
    // has already admitted them, so there is nothing to review.
    if (res.status === "requested") {
      const [ov, settings, to, col] = await Promise.all([
        getOverrides(propertyId),
        getSettings(propertyId),
        collectionOperatorEmails(slug),
        getCollectionBySlug(slug),
      ]);
      const appUrl = getConfig().appUrl.replace(/\/+$/, "");
      const location = [settings.addressCity, settings.addressCountry].filter(Boolean).join(", ");
      await sendCollectionRequestEmail({
        pid: propertyId,
        to,
        propertyName: ov.hotelName || mine.name,
        propertyLocation: location || undefined,
        collectionName: col?.name ?? slug,
        reviewUrl: `${appUrl}/admin/collections/${slug}`,
      });
    }
    return { error: null, requestOkKey: `coReq_${res.status}` as const };
  }

  // Property-side actions. Scoped to properties this user can actually manage,
  // so nobody can remove someone else's listing.
  if (intent === "leave" || intent === "block" || intent === "acceptInvite" || intent === "declineInvite") {
    const slug = String(form.get("slug") || "");
    const propertyId = String(form.get("propertyId") || "");
    const allowed = (await getVisibleProperties(request)).some((p) => p.id === propertyId);
    if (allowed) {
      if (intent === "leave") await endMembership(slug, propertyId);
      else if (intent === "block") await endMembership(slug, propertyId, true);
      else await resolveMembership(slug, propertyId, intent === "acceptInvite");
    }
    return redirect("/admin/collections");
  }

  return redirect("/admin/collections");
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "navCollections" });
}

export default function AdminCollections({ loaderData, actionData }: Route.ComponentProps) {
  const { collections, listings, joinable, appUrl } = loaderData;
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const host = appUrl.replace(/^https?:\/\//, "");
  const t = useAdminT();

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">{t("coTitle")}</h1>
      <p className="mb-6 max-w-[640px] text-[14px] text-muted">{t("coIntro")}</p>

      {collections.length === 0 && (
        <div className="mb-7 rounded-[14px] border border-dashed border-line bg-surface px-5 py-6 text-[14px] text-muted">
          {t("coEmpty")}
        </div>
      )}

      {collections.length > 0 && (
        <div className="mb-7 overflow-hidden rounded-[14px] border border-line bg-surface">
          {collections.map((c, i) => (
            <div
              key={c.slug}
              className={`flex flex-wrap items-center justify-between gap-3 px-5 py-4 ${
                i > 0 ? "border-t border-divider" : ""
              }`}
            >
              <div className="min-w-0">
                <div className="font-semibold">{c.name}</div>
                <div className="mt-0.5 font-mono text-[12px] text-muted-2">
                  {host}/c/{c.slug}
                </div>
                <div className="mt-0.5 text-[12px] text-muted">
                  {t(c.propertyIds.length === 1 ? "coProperties_one" : "coProperties_other", {
                    n: c.propertyIds.length,
                  })}
                  {c.destination ? ` · ${c.destination}` : ""}
                </div>
              </div>
              <div className="flex flex-none items-center gap-4 text-[13px] font-semibold">
                <Link to={`/c/${c.slug}`} target="_blank" className="text-muted hover:text-accent">
                  {t("coView")}
                </Link>
                <Link to={`/admin/collections/${c.slug}`} className="text-accent hover:underline">
                  {t("coEdit")}
                </Link>
                <Form
                  method="post"
                  onSubmit={(e) => {
                    if (!confirm(t("coDeleteConfirm", { name: c.name }))) e.preventDefault();
                  }}
                >
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="slug" value={c.slug} />
                  <button type="submit" className="text-[#c0392b] hover:underline">
                    {t("coDelete")}
                  </button>
                </Form>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Where your properties appear in OTHER people's collections. A curated
          collection can list a property without asking first, so this is the
          property's own control: see it, leave it, or refuse the collection
          outright so it can't simply re-add you. */}
      {listings.length > 0 && (
        <section className="mb-8 rounded-[14px] border border-line bg-surface p-6">
          <h2 className="font-serif text-[18px] font-semibold">{t("coListedInTitle")}</h2>
          <p className="mt-1 text-[13px] text-muted">{t("coListedInIntro")}</p>
          <div className="mt-4 flex flex-col gap-2">
            {listings.map((l) => (
              <div
                key={`${l.slug}:${l.propertyId}`}
                className="flex flex-wrap items-center gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3 text-[13.5px]"
              >
                <span className="font-semibold text-ink">{l.propertyName}</span>
                <span className="text-muted">{t("coListedInOn")}</span>
                <Link to={`/c/${l.slug}`} target="_blank" className="font-semibold text-accent hover:underline">
                  {l.collectionName}
                </Link>
                {l.status !== "active" && (
                  <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-muted">
                    {t(`coStatus_${l.status}`)}
                  </span>
                )}
                <span className="flex-1" />
                <Form method="post" className="flex items-center gap-3">
                  <input type="hidden" name="slug" value={l.slug} />
                  <input type="hidden" name="propertyId" value={l.propertyId} />
                  {l.status === "invited" ? (
                    <>
                      <button type="submit" name="intent" value="acceptInvite" className="rounded-[9px] bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-white">
                        {t("coAcceptInvite")}
                      </button>
                      <button type="submit" name="intent" value="declineInvite" className="text-[12.5px] font-semibold text-secondary hover:underline">
                        {t("coDecline")}
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="submit" name="intent" value="leave" className="text-[12.5px] font-semibold text-secondary hover:underline">
                        {t("coLeave")}
                      </button>
                      <button type="submit" name="intent" value="block" className="text-[12.5px] font-semibold text-[#c0392b] hover:underline" title={t("coBlockHelp")}>
                        {t("coBlock")}
                      </button>
                    </>
                  )}
                </Form>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Ask to be listed somewhere. Invite-only and private collections aren't
          here — offering a request that always fails is worse than not offering
          one. An `open` collection lists you straight away, so its button says so. */}
      {joinable.length > 0 && (
        <section className="mb-8 rounded-[14px] border border-line bg-surface p-6">
          <h2 className="font-serif text-[18px] font-semibold">{t("coJoinTitle")}</h2>
          <p className="mt-1 text-[13px] text-muted">{t("coJoinIntro")}</p>

          {actionData && "requestOkKey" in actionData && actionData.requestOkKey && (
            <p className="mt-4 rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-800">
              {t(actionData.requestOkKey)}
            </p>
          )}
          {actionData && "requestErrorKey" in actionData && actionData.requestErrorKey && (
            <p className="mt-4 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
              {t(actionData.requestErrorKey)}
            </p>
          )}

          <div className="mt-4 flex flex-col gap-2">
            {joinable.map((j) => (
              <Form
                key={j.slug}
                method="post"
                className="flex flex-wrap items-center gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3 text-[13.5px]"
              >
                <input type="hidden" name="slug" value={j.slug} />
                <Link to={`/c/${j.slug}`} target="_blank" className="font-semibold text-ink hover:text-accent">
                  {j.name}
                </Link>
                {j.destination && <span className="text-muted">{j.destination}</span>}
                <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-muted">
                  {t(j.memberCount === 1 ? "coJoinMembers_one" : "coJoinMembers_other", { n: String(j.memberCount) })}
                </span>
                <span className="flex-1" />
                {/* One row per collection, so which property is asking has to be
                    chosen here rather than inferred. */}
                <select
                  name="propertyId"
                  className="rounded-[9px] border border-line-alt bg-surface px-2 py-1.5 text-[12.5px]"
                >
                  {j.options.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
                <button
                  type="submit"
                  name="intent"
                  value="requestJoin"
                  className="rounded-[9px] bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-white"
                >
                  {j.mode === "open" ? t("coJoinNow") : t("coJoinAsk")}
                </button>
              </Form>
            ))}
          </div>
        </section>
      )}

      <Form method="post" className="flex flex-col gap-4 rounded-[14px] border border-line bg-surface p-6">
        <input type="hidden" name="intent" value="add" />
        <h2 className="font-serif text-[18px] font-semibold">{t("coNewCollection")}</h2>
        <label className="block max-w-md text-[13px] font-semibold text-secondary">
          {t("coName")}
          <input name="name" placeholder="The Laurel Collection" className={FIELD_INPUT} />
          <span className="mt-1 block text-[11px] font-normal text-faint">
            {t("coNameHint", { host })}
          </span>
        </label>
        {actionData?.error && <p className="text-[13px] text-red-600">{actionData.error}</p>}
        <div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {saving ? t("coCreating") : t("coCreate")}
          </button>
        </div>
      </Form>
    </div>
  );
}
