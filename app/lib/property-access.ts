// Pure property-access rules. Server wrappers in properties.server.ts load the
// actor + property and call these; unit tests cover the decisions without KV.

export type AccessActor = {
  email: string;
  role?: string;
  partnerId?: string;
  superadmin?: boolean;
};

export type AccessProperty = {
  owner?: string;
  partnerId?: string;
};

/** Hotel owner or platform superadmin. Teammates and partner_admins who do not
 *  personally own the hotel fail — money, listing, slug, live booking. */
export function canOwnProperty(actor: AccessActor, property: AccessProperty | undefined): boolean {
  if (!actor.email) return false;
  if (actor.superadmin) return true;
  return Boolean(property && property.owner === actor.email);
}

/** Owner, partner_admin of that hotel's partner, or superadmin. Teammates fail.
 *  Does not consult member-area hide or partner hiddenPages — those overlays
 *  never apply to partner_admin. */
export function canManageProperty(actor: AccessActor, property: AccessProperty | undefined): boolean {
  if (canOwnProperty(actor, property)) return true;
  if (!property?.partnerId) return false;
  return actor.role === "partner_admin" && actor.partnerId === property.partnerId;
}

/** Keep the stored value unless the actor may persist an owner-only field
 *  (live booking, auto-refund, …). A teammate POST that includes the field
 *  must not change it. */
export function ownerOnlyValue<T>(existing: T, proposed: T, canOwn: boolean): T {
  return canOwn ? proposed : existing;
}
