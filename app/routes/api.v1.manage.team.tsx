import type { Route } from "./+types/api.v1.manage.team";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { sendTeamInviteRequestEmail } from "~/lib/email.server";
import { MEMBER_AREAS } from "~/lib/member-areas";
import { getProperty } from "~/lib/properties.server";
import { addPendingInvite, listPendingInvites, type PendingInvite } from "~/lib/team-invites.server";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const serializeTeam = (
  ref: NonNullable<Awaited<ReturnType<typeof getProperty>>>,
  pending: PendingInvite[] = [],
) => ({
  owner: ref.owner ?? null,
  members: (ref.members ?? []).map((email) => ({
    email,
    // Stored is the COMPLEMENT (hidden areas, absent = full access); the API
    // speaks in what the member CAN see, like the UI's checkboxes.
    areas: MEMBER_AREAS.filter((a) => !(ref.memberHiddenAreas?.[email] ?? []).includes(a)),
  })),
  // Invites requested through the API and not yet approved by the owner.
  pending: pending.map((i) => ({ email: i.email, requested_at: i.requestedAt })),
  areas: MEMBER_AREAS,
});

// GET  /v1/manage/team — the property's owner + teammates with their visible
//      admin areas, plus invites still waiting for the owner.
// POST /v1/manage/team — REQUEST that one person be added to THIS property.
//      Nobody joins the team from here: the request is parked, the owner is
//      emailed, and the person is only added (and only then emailed a sign-in
//      link) when the owner approves it on the admin Team page. A key is not a
//      person; an account it could mint outright would outlive the key.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const ref = await getProperty(auth.pid);
  if (!ref) return apiError(404, "not_found", "Property not found.");
  return Response.json({ data: serializeTeam(ref, await listPendingInvites(auth.pid)) });
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "POST") return apiError(405, "method_not_allowed", "Use POST with { email } to request an invite.");
  let body: { email?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) return apiError(422, "validation_error", "`email` must be a valid address.");

  const ref = await getProperty(auth.pid);
  if (!ref) return apiError(404, "not_found", "Property not found.");
  // Already on the team (or the owner): nothing to request.
  if (ref.owner?.toLowerCase() === email || (ref.members ?? []).includes(email)) {
    return Response.json({ data: serializeTeam(ref, await listPendingInvites(auth.pid)) });
  }

  const { created } = await addPendingInvite(auth.pid, email);
  // Tell the owner once per distinct request — a retried call must not nag.
  if (created && ref.owner) {
    const origin = new URL(request.url).origin;
    await sendTeamInviteRequestEmail(auth.pid, ref.owner, email, `${origin}/admin/team`, ref.partnerId);
  }
  return Response.json({ data: serializeTeam(ref, await listPendingInvites(auth.pid)) }, { status: 202 });
}
