import type { Route } from "./+types/api.v1.manage.team";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { sendTeamInviteEmail } from "~/lib/email.server";
import { MEMBER_AREAS } from "~/lib/member-areas";
import { addPropertyMember, getProperty } from "~/lib/properties.server";
import { getUser, setUserPartner, upsertUser } from "~/lib/users.server";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const serializeTeam = (ref: NonNullable<Awaited<ReturnType<typeof getProperty>>>) => ({
  owner: ref.owner ?? null,
  members: (ref.members ?? []).map((email) => ({
    email,
    // Stored is the COMPLEMENT (hidden areas, absent = full access); the API
    // speaks in what the member CAN see, like the UI's checkboxes.
    areas: MEMBER_AREAS.filter((a) => !(ref.memberHiddenAreas?.[email] ?? []).includes(a)),
  })),
  areas: MEMBER_AREAS,
});

// GET  /v1/manage/team — the property's owner + teammates with their visible
//      admin areas.
// POST /v1/manage/team/invites (this route, method POST) — invite ONE teammate
//      to THIS property. The one management endpoint that sends email (the
//      invite), and only to the address being invited. Unlike the admin page,
//      no multi-property fan-out: a property-scoped key invites to its own
//      property only.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const ref = await getProperty(auth.pid);
  if (!ref) return apiError(404, "not_found", "Property not found.");
  return Response.json({ data: serializeTeam(ref) });
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "POST") return apiError(405, "method_not_allowed", "Use POST with { email } to invite.");
  let body: { email?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) return apiError(422, "validation_error", "`email` must be a valid address.");

  await addPropertyMember(auth.pid, email);
  // Same user-precreation rules as the admin invite: a NEW user under a
  // white-label partner is scoped to that partner from their first sign-in;
  // an existing user's affiliation is never rewritten by a mere invite.
  const partnerId = (await getProperty(auth.pid))?.partnerId;
  const existing = await getUser(email);
  if (!existing && partnerId) await setUserPartner(email, partnerId);
  else await upsertUser(email);
  const origin = new URL(request.url).origin;
  await sendTeamInviteEmail(auth.pid, email, "the management API", `${origin}/admin/login?email=${encodeURIComponent(email)}`, partnerId);

  const ref = await getProperty(auth.pid);
  return Response.json({ data: serializeTeam(ref!) }, { status: 201 });
}
