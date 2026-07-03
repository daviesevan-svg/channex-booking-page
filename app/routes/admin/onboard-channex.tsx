import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/onboard-channex";
import { FIELD_INPUT } from "~/components/admin-form";
import { requireAdmin, setSessionProperty } from "~/lib/auth.server";
import {
  getChannexRatePlans,
  getChannexRoomTypes,
  listChannexProperties,
  type ChannexProperty,
  type ChannexRatePlan,
  type ChannexRoomType,
} from "~/lib/channex/pms.server";
import { saveRate, saveRoom } from "~/lib/catalog.server";
import { DEFAULT_LANG } from "~/lib/content";
import { patchSettings, saveOverrides } from "~/lib/overrides.server";
import { addProperty } from "~/lib/properties.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  return null;
}

/** Creates the local property + chosen rooms/rates from the Channex data. Uses
 *  the Channex ids as our local ids so Open Channel ARI mapping lines up. Rooms
 *  and rates are written sequentially (each save is read-modify-write on one KV
 *  key — concurrent writes would clobber). */
async function importFromChannex(
  owner: string,
  property: ChannexProperty,
  rooms: ChannexRoomType[],
  rates: ChannexRatePlan[],
) {
  const pid = property.id;
  await addProperty(pid, property.title, owner);
  await saveOverrides(pid, DEFAULT_LANG, {
    hotelName: property.title,
    address: property.address ?? "",
    email: property.email ?? "",
    phone: property.phone ?? "",
  });
  await patchSettings(pid, {
    currency: property.currency,
    timezone: property.timezone,
    addressCity: property.city,
    addressRegion: property.state,
    addressCountry: property.country,
    addressPostalCode: property.zipCode,
    latitude: property.latitude,
    longitude: property.longitude,
    connectedSystem: "channex",
  });

  const now = new Date().toISOString();
  let position = 0;
  for (const r of rooms) {
    await saveRoom(pid, {
      id: r.id,
      title: r.title,
      description: r.description,
      images: r.photos,
      maxAdults: r.maxAdults,
      maxGuests: r.maxGuests,
      facilities: r.facilities,
      position: position++,
      createdAt: now,
    });
  }

  const importedRoomIds = new Set(rooms.map((r) => r.id));
  for (const rp of rates) {
    if (!importedRoomIds.has(rp.roomTypeId)) continue; // its room wasn't imported
    await saveRate(pid, {
      id: rp.id,
      title: rp.title,
      mealPlan: rp.mealPlan,
      prices: rp.nightlyPrice != null ? { [rp.roomTypeId]: rp.nightlyPrice } : {},
      refundable: true,
      inclusions: [],
      active: true,
      createdAt: now,
    });
  }
}

export async function action({ request }: Route.ActionArgs) {
  const email = await requireAdmin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const apiKey = String(form.get("apiKey") || "").trim();
  if (!apiKey) return { error: "Enter your Channex API key." };

  try {
    if (intent === "connect") {
      const properties = await listChannexProperties(apiKey);
      if (properties.length === 0) return { step: "pick" as const, apiKey, properties, error: "No properties found for that key." };
      const propertyId = String(form.get("channexPropertyId") || "");
      if (!propertyId) return { step: "pick" as const, apiKey, properties };
      const property = properties.find((p) => p.id === propertyId);
      if (!property) return { step: "pick" as const, apiKey, properties };
      const [rooms, rates] = await Promise.all([
        getChannexRoomTypes(apiKey, propertyId),
        getChannexRatePlans(apiKey, propertyId),
      ]);
      return { step: "review" as const, apiKey, properties, propertyId, property, rooms, rates };
    }

    if (intent === "import") {
      const propertyId = String(form.get("channexPropertyId") || "");
      const roomIds = new Set(form.getAll("rooms").map(String));
      const rateIds = new Set(form.getAll("rates").map(String));
      const [properties, roomTypes, ratePlans] = await Promise.all([
        listChannexProperties(apiKey),
        getChannexRoomTypes(apiKey, propertyId),
        getChannexRatePlans(apiKey, propertyId),
      ]);
      const property = properties.find((p) => p.id === propertyId);
      if (!property) return { error: "That property is no longer available." };
      if (roomIds.size === 0) {
        return {
          step: "review" as const,
          apiKey,
          properties,
          propertyId,
          property,
          rooms: roomTypes,
          rates: ratePlans,
          error: "Pick at least one room type to import.",
        };
      }
      await importFromChannex(
        email,
        property,
        roomTypes.filter((r) => roomIds.has(r.id)),
        ratePlans.filter((rp) => rateIds.has(rp.id)),
      );
      return redirect("/admin", {
        headers: { "Set-Cookie": await setSessionProperty(request, property.id) },
      });
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Something went wrong talking to Channex." };
  }
  return { error: "Unknown action." };
}

export function meta() {
  return [{ title: "Admin · Onboard from Channex" }];
}

export default function OnboardChannex({ actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const step = actionData && "step" in actionData ? actionData.step : "key";
  const apiKey = actionData && "apiKey" in actionData ? actionData.apiKey : "";
  const properties = (actionData && "properties" in actionData ? actionData.properties : []) ?? [];
  const property = actionData && "property" in actionData ? actionData.property : undefined;
  const rooms = (actionData && "rooms" in actionData ? actionData.rooms : []) ?? [];
  const rates = (actionData && "rates" in actionData ? actionData.rates : []) ?? [];
  const error = actionData && "error" in actionData ? actionData.error : undefined;

  return (
    <div className="max-w-[720px]">
      <div className="mb-4">
        <Link to="/admin/properties" className="text-[13px] font-semibold text-muted hover:text-accent">
          ← All properties
        </Link>
      </div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">Onboard from Channex</h1>
      <p className="mb-6 max-w-[620px] text-[14px] text-muted">
        Import a property’s details, room types and rate plans straight from your Channex account.
        Paste your Channex <strong>API key</strong> (Channex → Applications → API keys). It’s used
        only for this import and never stored.
      </p>

      {/* Step 1: API key + connect. Also carries the key on later steps. */}
      <Form method="post" className="flex flex-col gap-5">
        <input type="hidden" name="intent" value="connect" />
        <section className="rounded-[14px] border border-line bg-surface p-6">
          <label className="block text-[13px] font-semibold text-secondary">
            Channex API key
            {step === "key" ? (
              <input
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder="Paste your user-api-key"
                className={`${FIELD_INPUT} font-mono`}
              />
            ) : (
              <div className="mt-1.5 flex items-center gap-3">
                <span className="rounded-full bg-[#e8f0e6] px-2.5 py-0.5 text-[12px] font-semibold text-[#3f7a52]">
                  Connected
                </span>
                <input type="hidden" name="apiKey" value={apiKey} />
              </div>
            )}
          </label>

          {/* Property picker (once connected). Changing it re-fetches its catalogue. */}
          {step !== "key" && properties.length > 0 && (
            <label className="mt-4 block text-[13px] font-semibold text-secondary">
              Property
              <select
                name="channexPropertyId"
                defaultValue={property?.id ?? ""}
                onChange={(e) => e.currentTarget.form?.requestSubmit()}
                className={FIELD_INPUT}
              >
                <option value="" disabled>
                  Choose a property…
                </option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                    {p.city ? ` — ${p.city}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}

          {error && <p className="mt-3 text-[13px] text-red-600">{error}</p>}

          {step === "key" && (
            <button
              type="submit"
              disabled={busy}
              className="mt-4 rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          )}
        </section>
      </Form>

      {/* Step 3: review + choose rooms/rates to import. */}
      {step === "review" && property && (
        <Form method="post" className="mt-6 flex flex-col gap-5">
          <input type="hidden" name="intent" value="import" />
          <input type="hidden" name="apiKey" value={apiKey} />
          <input type="hidden" name="channexPropertyId" value={property.id} />

          <section className="rounded-[14px] border border-line bg-surface p-6">
            <div className="mb-1 font-serif text-[18px] font-semibold">{property.title}</div>
            <div className="text-[13px] text-muted">
              {[property.address, property.city, property.country].filter(Boolean).join(", ") || "No address on file"}
              {property.currency ? ` · ${property.currency}` : ""}
            </div>
          </section>

          <section className="rounded-[14px] border border-line bg-surface p-6">
            <div className="mb-3 font-serif text-[18px] font-semibold">
              Room types <span className="font-sans text-[13px] font-normal text-muted">({rooms.length})</span>
            </div>
            {rooms.length === 0 ? (
              <p className="text-[13.5px] text-muted">No room types found for this property.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {rooms.map((r) => (
                  <label
                    key={r.id}
                    className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3"
                  >
                    <input type="checkbox" name="rooms" value={r.id} defaultChecked className="mt-1" />
                    <span className="flex-1">
                      <span className="block text-[14px] font-semibold text-ink">{r.title}</span>
                      <span className="block text-[12.5px] text-muted">
                        Sleeps {r.maxGuests} · {r.maxAdults} adult{r.maxAdults === 1 ? "" : "s"}
                        {r.facilities.length ? ` · ${r.facilities.slice(0, 3).join(", ")}` : ""}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-[14px] border border-line bg-surface p-6">
            <div className="mb-1 font-serif text-[18px] font-semibold">
              Rate plans <span className="font-sans text-[13px] font-normal text-muted">({rates.length})</span>
            </div>
            <p className="mb-3 text-[12.5px] text-muted">
              A rate only imports if its room type is also selected. Prices are imported as a starting
              point — review them after, live nightly rates flow from Channex.
            </p>
            {rates.length === 0 ? (
              <p className="text-[13.5px] text-muted">No rate plans found for this property.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {rates.map((rp) => (
                  <label
                    key={rp.id}
                    className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3"
                  >
                    <input type="checkbox" name="rates" value={rp.id} defaultChecked className="mt-1" />
                    <span className="flex-1">
                      <span className="block text-[14px] font-semibold text-ink">{rp.title}</span>
                      <span className="block text-[12.5px] text-muted">
                        {rp.mealPlan ?? "Room only"}
                        {rp.nightlyPrice != null ? ` · from ${rp.currency ?? ""}${rp.nightlyPrice}/night` : ""}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>

          {error && <p className="text-[13px] text-red-600">{error}</p>}

          <div>
            <button
              type="submit"
              disabled={busy}
              className="rounded-[10px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
            >
              {busy ? "Importing…" : "Import & create property"}
            </button>
          </div>
        </Form>
      )}
    </div>
  );
}
