import type { Route } from "./+types/api.v1.manage.properties";
import { apiError, authenticateApiKey, issueApiKey } from "~/lib/api-auth.server";
import { addProperty, getProperties, getProperty } from "~/lib/properties.server";
import { validationError, type Errors } from "~/lib/manage-validate";

// POST /v1/manage/properties — create a NEW property under the same owner as
// the key's property. UI parity: any signed-in owner can add a property on
// /admin/properties, so a management key may too (2026-08-29 decision,
// superseding the spec note that reserved create for the partner API —
// ownership transfer and delete stay off the property-scoped key).
//
// The owner and partner come from the key property's REGISTRY RECORD, not from
// any session: an API key has no user, and the record is what the UI would
// have stamped anyway (creator = owner; partnerId from the creating user).
//
// An ak_ key stays scoped to ITS property, so the response also mints and
// returns a management key for the new property (shown once, like the admin
// key page) — without it the caller could create a property it can never
// touch. Blast radius of a leaked key is unchanged for EXISTING properties:
// the minted key only opens the property this call just created.

/** Registry sanity cap. The registry is one KV value read on every admin and
 *  guest resolve, so an agent loop must not be able to grow it unboundedly. */
const MAX_OWNED_PROPERTIES = 50;

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "POST") return apiError(405, "method_not_allowed", "POST { name } to create a property.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const errors: Errors = {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return apiError(422, "validation_error", "Body must be a JSON object: { name }.");
  }
  const obj = body as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (k !== "name") (errors[k] ??= []).push("Unknown field.");
  }
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (obj.name === undefined) (errors.name ??= []).push("Required.");
  else if (typeof obj.name !== "string" || !name) (errors.name ??= []).push("Must be a non-empty string.");
  else if (name.length > 120) (errors.name ??= []).push("At most 120 characters.");
  if (Object.keys(errors).length) return validationError(errors);

  const source = await getProperty(auth.pid);
  const owner = source?.owner;
  if (!source || !owner) {
    // Ownerless = legacy/unclaimed: a property created under it would be
    // invisible to every non-superadmin admin account — refuse loudly instead.
    return apiError(409, "no_owner", "This key's property has no owner account, so the new property would be unreachable in the admin. Assign an owner on the Users page first.");
  }
  const owned = (await getProperties()).filter((p) => p.owner === owner).length;
  if (owned >= MAX_OWNED_PROPERTIES) {
    return apiError(409, "property_limit", `This account already has ${MAX_OWNED_PROPERTIES} properties — contact support to raise the limit.`);
  }

  const ref = await addProperty(crypto.randomUUID(), name, owner, source.partnerId);
  const { raw } = await issueApiKey(ref.id, { label: "Created via API", mode: "live", scope: "manage" });
  return Response.json(
    {
      data: {
        id: ref.id,
        name: ref.name,
        // Shown ONCE — stored only as a hash, exactly like keys from the admin.
        api_key: raw,
      },
    },
    { status: 201 },
  );
}
