import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/onboard-channex";
import { FIELD_INPUT } from "~/components/admin-form";
import { useAdminT } from "~/lib/admin-i18n";
import { requireAdmin, setSessionProperty } from "~/lib/auth.server";
import {
  getChannexRatePlans,
  getChannexRoomTypes,
  listChannexProperties,
  type ChannexProperty,
  type ChannexRatePlan,
  type ChannexRoomType,
} from "~/lib/channex/pms.server";
import { replaceRates, replaceRooms } from "~/lib/catalog.server";
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
  await replaceRooms(
    pid,
    rooms.map((r, position) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      images: r.photos,
      maxAdults: r.maxAdults,
      maxGuests: r.maxGuests,
      facilities: r.facilities,
      position,
      createdAt: now,
    })),
  );

  const importedRoomIds = new Set(rooms.map((r) => r.id));
  // Channex stores one rate-plan record per room type, but our model is one rate
  // plan spanning many rooms. Consolidate by title into a single rate applied to
  // every imported room it covers. `channexRateIds` keeps each room's real
  // Channex rate id so ARI, mapping and booking pushes still key per room.
  const byTitle = new Map<
    string,
    { first: ChannexRatePlan; prices: Record<string, number>; channexRateIds: Record<string, string> }
  >();
  for (const rp of rates) {
    if (!importedRoomIds.has(rp.roomTypeId)) continue; // its room wasn't imported
    const g = byTitle.get(rp.title) ?? { first: rp, prices: {}, channexRateIds: {} };
    g.prices[rp.roomTypeId] = 0; // base 0 — live nightly rates flow in from Channex ARI
    g.channexRateIds[rp.roomTypeId] = rp.id;
    byTitle.set(rp.title, g);
  }
  // Replace, not append — a re-import rebuilds the catalog cleanly rather than
  // leaving the previous import's per-room duplicates behind.
  await replaceRates(
    pid,
    [...byTitle.values()].map((g) => ({
      id: g.first.id, // one of the Channex rate ids doubles as our local id
      title: g.first.title,
      mealPlan: g.first.mealPlan,
      prices: g.prices,
      channexRateIds: g.channexRateIds,
      refundable: true,
      inclusions: [],
      active: true,
      createdAt: now,
    })),
  );
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
      // Rate plans are chosen by title: Channex stores one rate-plan record per
      // room type, so a single "Book Direct" plan is really N records. Selecting
      // by title imports it for every (selected) room type in one tick.
      const rateTitles = new Set(form.getAll("rateTitles").map(String));
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
        ratePlans.filter((rp) => rateTitles.has(rp.title)),
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
  const t = useAdminT();
  const step = actionData && "step" in actionData ? actionData.step : "key";
  const apiKey = actionData && "apiKey" in actionData ? actionData.apiKey : "";
  const properties = (actionData && "properties" in actionData ? actionData.properties : []) ?? [];
  const property = actionData && "property" in actionData ? actionData.property : undefined;
  const rooms = (actionData && "rooms" in actionData ? actionData.rooms : []) ?? [];
  const rates = (actionData && "rates" in actionData ? actionData.rates : []) ?? [];
  const error = actionData && "error" in actionData ? actionData.error : undefined;

  // Channex keeps one rate-plan record per room type, so a single logical plan
  // (e.g. "Book Direct") appears once per room. Group by title so the owner
  // picks logical plans, not dozens of duplicates. A group is "OTA" if any of
  // its records is distributed to an OTA channel.
  const rateGroups = Object.values(
    rates.reduce<
      Record<string, { title: string; mealPlan?: string; rooms: Set<string>; ota: boolean; otaChannels: string[] }>
    >((acc, rp) => {
      const g = (acc[rp.title] ??= { title: rp.title, mealPlan: rp.mealPlan, rooms: new Set(), ota: false, otaChannels: [] });
      g.rooms.add(rp.roomTypeId); // distinct room types, not raw records (Channex has one per room)
      if (rp.mealPlan && !g.mealPlan) g.mealPlan = rp.mealPlan;
      if (rp.ota) {
        g.ota = true;
        for (const c of rp.otaChannels) if (!g.otaChannels.includes(c)) g.otaChannels.push(c);
      }
      return acc;
    }, {}),
  ).map((g) => ({ ...g, count: g.rooms.size }));
  const directGroups = rateGroups.filter((g) => !g.ota);
  const otaGroups = rateGroups.filter((g) => g.ota);

  return (
    <div className="max-w-[720px]">
      <div className="mb-4">
        <Link to="/admin/properties" className="text-[13px] font-semibold text-muted hover:text-accent">
          {t("obBack")}
        </Link>
      </div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">{t("obTitle")}</h1>
      <p className="mb-6 max-w-[620px] text-[14px] text-muted">
        {t("obIntroPre")} <strong>{t("obApiKey")}</strong>
        {t("obIntroPost")}
      </p>

      {/* Step 1: API key + connect. Also carries the key on later steps. */}
      <Form method="post" className="flex flex-col gap-5">
        <input type="hidden" name="intent" value="connect" />
        <section className="rounded-[14px] border border-line bg-surface p-6">
          <label className="block text-[13px] font-semibold text-secondary">
            {t("obApiKeyLabel")}
            {step === "key" ? (
              <input
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder={t("obApiKeyPlaceholder")}
                className={`${FIELD_INPUT} font-mono`}
              />
            ) : (
              <div className="mt-1.5 flex items-center gap-3">
                <span className="rounded-full bg-[#e8f0e6] px-2.5 py-0.5 text-[12px] font-semibold text-[#3f7a52]">
                  {t("obConnected")}
                </span>
                <input type="hidden" name="apiKey" value={apiKey} />
              </div>
            )}
          </label>

          {/* Property picker (once connected). Changing it re-fetches its catalogue. */}
          {step !== "key" && properties.length > 0 && (
            <label className="mt-4 block text-[13px] font-semibold text-secondary">
              {t("obPropertyLabel")}
              <select
                name="channexPropertyId"
                defaultValue={property?.id ?? ""}
                onChange={(e) => e.currentTarget.form?.requestSubmit()}
                className={FIELD_INPUT}
              >
                <option value="" disabled>
                  {t("obChooseProperty")}
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
              {busy ? t("obConnecting") : t("obConnect")}
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
              {[property.address, property.city, property.country].filter(Boolean).join(", ") || t("obNoAddress")}
              {property.currency ? ` · ${property.currency}` : ""}
            </div>
          </section>

          <section className="rounded-[14px] border border-line bg-surface p-6">
            <div className="mb-3 font-serif text-[18px] font-semibold">
              {t("obRoomTypes")} <span className="font-sans text-[13px] font-normal text-muted">({rooms.length})</span>
            </div>
            {rooms.length === 0 ? (
              <p className="text-[13.5px] text-muted">{t("obNoRooms")}</p>
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
                        {t(r.maxAdults === 1 ? "obSleepsAdults_one" : "obSleepsAdults_other", {
                          guests: r.maxGuests,
                          adults: r.maxAdults,
                        })}
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
              {t("obRatePlans")} <span className="font-sans text-[13px] font-normal text-muted">({rateGroups.length})</span>
            </div>
            <p className="mb-3 text-[12.5px] text-muted">
              {t("obRatesHint")}
            </p>
            {rateGroups.length === 0 ? (
              <p className="text-[13.5px] text-muted">{t("obNoRates")}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {directGroups.map((g) => (
                  <label
                    key={g.title}
                    className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3"
                  >
                    <input type="checkbox" name="rateTitles" value={g.title} defaultChecked className="mt-1" />
                    <span className="flex-1">
                      <span className="block text-[14px] font-semibold text-ink">{g.title}</span>
                      <span className="block text-[12.5px] text-muted">
                        {g.mealPlan ?? t("obRoomOnly")} · {t(g.count === 1 ? "obRoomTypesCount_one" : "obRoomTypesCount_other", { n: g.count })}
                      </span>
                    </span>
                  </label>
                ))}

                {otaGroups.length > 0 && (
                  <>
                    <div className="mt-4 mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted-2">
                      {t("obOtaHeading")}
                    </div>
                    <p className="mb-2 text-[12.5px] text-muted">
                      {t("obOtaHint")}
                    </p>
                    {otaGroups.map((g) => (
                      <label
                        key={g.title}
                        className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-dashed border-line-alt bg-surface px-4 py-3"
                      >
                        <input type="checkbox" name="rateTitles" value={g.title} className="mt-1" />
                        <span className="flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-[14px] font-semibold text-ink">{g.title}</span>
                            {g.otaChannels.map((c) => (
                              <span
                                key={c}
                                className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-semibold text-muted"
                              >
                                {c}
                              </span>
                            ))}
                          </span>
                          <span className="block text-[12.5px] text-muted">
                            {g.mealPlan ?? t("obRoomOnly")} · {t(g.count === 1 ? "obRoomTypesCount_one" : "obRoomTypesCount_other", { n: g.count })}
                          </span>
                        </span>
                      </label>
                    ))}
                  </>
                )}
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
              {busy ? t("obImporting") : t("obImport")}
            </button>
          </div>
        </Form>
      )}
    </div>
  );
}
