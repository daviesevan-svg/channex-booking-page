// Deleting a property, the whole job.
//
// `removeProperty` only drops the registry row (and tombstones the id), on the
// long-standing promise that content survives so a mistaken delete can be
// undone. Content can wait; credentials cannot. The data layer is keyed by the
// id, ids are public (guest URLs, the Viva webhook address), and until this
// existed anyone who re-registered a deleted id inherited a live connected
// Stripe account, Viva credentials, working API keys and webhook secrets.
//
// So this revokes and clears everything that grants access or moves money,
// THEN removes the row. Rooms, texts, images and bookings stay (the same owner
// can re-add the id and have them back; nobody else can).
import { revokeAllApiKeys } from "./api-auth.server";
import { clearSettingsFields, saveVivaConfig } from "./overrides.server";
import { removeProperty } from "./properties.server";
import { deleteAllWebhooks } from "./webhooks.server";

/** Settings that grant access, route money, or switch live traffic on. */
const CREDENTIAL_FIELDS = [
  "stripeAccountId",
  "stripeChargesEnabled",
  "liveBooking",
  "connectedSystem",
  "googleAriPush",
] as const;

export async function deletePropertyForGood(id: string): Promise<void> {
  await revokeAllApiKeys(id);
  await deleteAllWebhooks(id);
  await saveVivaConfig(id, null);
  await clearSettingsFields(id, [...CREDENTIAL_FIELDS]);
  await removeProperty(id);
}
