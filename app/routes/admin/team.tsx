import { Form, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/team";
import { FIELD_INPUT } from "~/components/admin-form";
import { requireAdmin } from "~/lib/auth.server";
import {
  addPropertyMember,
  currentPropertyId,
  getProperty,
  isOwnerOrSuper,
  removePropertyMember,
} from "~/lib/properties.server";
import { upsertUser } from "~/lib/users.server";

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
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId || !(await isOwnerOrSuper(request, propertyId))) throw redirect("/admin");
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const email = String(form.get("email") || "").trim().toLowerCase();

  if (intent === "invite" && email) {
    await addPropertyMember(propertyId, email);
    // Pre-create the user so they can sign in (even once sign-up is locked down)
    // and show up in the superadmin Users list.
    await upsertUser(email);
  } else if (intent === "remove" && email) {
    await removePropertyMember(propertyId, email);
  }
  return redirect("/admin/team");
}

export function meta() {
  return [{ title: "Admin · Team" }];
}

export default function AdminTeam({ loaderData }: Route.ComponentProps) {
  const { name, owner, members } = loaderData;
  const nav = useNavigation();
  const busy = nav.state === "submitting";

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">Team</h1>
      <p className="mb-6 text-[14px] text-muted">
        People who can manage <strong>{name || "this property"}</strong>. Teammates can edit
        everything for this property; only you (the owner) can manage the team, rename, or delete
        it. Teammates only ever see properties they’ve been added to.
      </p>

      <div className="mb-7 overflow-hidden rounded-[14px] border border-line bg-surface">
        {/* owner */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="font-semibold">{owner ?? <span className="italic text-faint">unassigned</span>}</span>
            <span className="rounded-full bg-[#e8f0e6] px-2 py-0.5 text-[11px] font-semibold text-[#3f7a52]">
              Owner
            </span>
          </div>
        </div>

        {/* teammates */}
        {members.map((m) => (
          <div
            key={m}
            className="flex flex-wrap items-center justify-between gap-3 border-t border-divider px-5 py-4"
          >
            <span className="font-semibold">{m}</span>
            <Form
              method="post"
              onSubmit={(e) => {
                if (!confirm(`Remove ${m} from this property’s team?`)) e.preventDefault();
              }}
            >
              <input type="hidden" name="intent" value="remove" />
              <input type="hidden" name="email" value={m} />
              <button type="submit" className="text-[13px] font-semibold text-[#c0392b] hover:underline">
                Remove
              </button>
            </Form>
          </div>
        ))}

        {members.length === 0 && (
          <div className="border-t border-divider px-5 py-4 text-[13px] text-muted">
            No teammates yet — invite someone below.
          </div>
        )}
      </div>

      {/* invite */}
      <Form method="post" className="flex flex-col gap-4 rounded-[14px] border border-line bg-surface p-6">
        <input type="hidden" name="intent" value="invite" />
        <h2 className="font-serif text-[18px] font-semibold">Invite a teammate</h2>
        <label className="block text-[13px] font-semibold text-secondary">
          Email
          <input
            name="email"
            type="email"
            required
            placeholder="teammate@example.com"
            className={FIELD_INPUT}
          />
          <span className="mt-1 block text-[11px] font-normal text-faint">
            They sign in with an emailed code to this address and get full access to this property.
          </span>
        </label>
        <div>
          <button
            type="submit"
            disabled={busy}
            className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
          >
            {busy ? "Inviting…" : "Invite teammate"}
          </button>
        </div>
      </Form>
    </div>
  );
}
