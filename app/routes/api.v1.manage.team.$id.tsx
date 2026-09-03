import type { Route } from "./+types/api.v1.manage.team.$id";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { MEMBER_AREAS, isMemberArea, type MemberArea } from "~/lib/member-areas";
import { getProperty, removePropertyMember, setMemberHiddenAreas } from "~/lib/properties.server";
import { listPendingInvites } from "~/lib/team-invites.server";
import { serializeTeam } from "./api.v1.manage.team";

// PATCH  /v1/manage/team/:email — { areas: [...] } sets which admin areas this
//        teammate can see (the API speaks in VISIBLE areas; the complement is
//        stored, so full access stays the default for untouched members).
// DELETE — remove the teammate from this property (their user account and any
//        other properties are untouched).
export async function action({ request, params }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const email = decodeURIComponent(String(params.id ?? "")).trim().toLowerCase();
  const ref = await getProperty(auth.pid);
  if (!ref) return apiError(404, "not_found", "Property not found.");
  if (!(ref.members ?? []).includes(email)) return apiError(404, "not_found", "No teammate with that email on this property.");

  if (request.method === "DELETE") {
    await removePropertyMember(auth.pid, email);
    return Response.json({ removed: true });
  }

  if (request.method === "PATCH") {
    let body: { areas?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return apiError(400, "bad_request", "Body must be JSON.");
    }
    if (!Array.isArray(body.areas) || body.areas.some((a) => typeof a !== "string" || !isMemberArea(a))) {
      return apiError(422, "validation_error", `\`areas\` must be an array of: ${MEMBER_AREAS.join(", ")}. Send all of them for full access.`);
    }
    const allowed = body.areas as MemberArea[];
    const hidden = MEMBER_AREAS.filter((a) => !allowed.includes(a));
    await setMemberHiddenAreas(auth.pid, email, hidden);
    const after = await getProperty(auth.pid);
    return Response.json({ data: serializeTeam(after!, await listPendingInvites(auth.pid)) });
  }

  return apiError(405, "method_not_allowed", "Use PATCH to set areas or DELETE to remove.");
}
