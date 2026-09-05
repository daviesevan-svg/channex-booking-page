import { describe, expect, it, vi } from "vitest";
import { makeTestD1 } from "./test-d1";

// The registry is D1-backed; these tests exercise property create/rename/team.
const { d1: testD1 } = makeTestD1();

// Settings/content/taxes writes: real route actions over in-memory KV. Pins:
// the allowlist (non-writable fields are 422s, not merges), null-clears
// semantics through patchSettings, the content patch staying scoped to ONE
// language (the wipe class of bug), the default-language rename side effect,
// and the tax document's loud validation.

const store = new Map<string, string>();
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
};

vi.mock("cloudflare:workers", () => ({
  env: { DB: testD1, CONFIG_KV: kv },
  waitUntil: () => {},
}));

const jsonReq = (path: string, key: string, method: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function setup() {
  store.set("properties", JSON.stringify([{ id: "p1", name: "Casa Test" }]));
  store.set("settings:p1", JSON.stringify({ currency: "EUR", connectedSystem: "channex", checkinTime: "15:00" }));
  store.set("overrides:p1", JSON.stringify({ en: { hotelName: "Casa Test", description: "English text." }, de: { description: "Deutscher Text." } }));
  const { issueApiKey } = await import("./api-auth.server");
  const { raw } = await issueApiKey("p1", { label: "s", mode: "live", scope: "manage" });
  return raw;
}
const akPromise = setup();

describe("PATCH /v1/manage/property", () => {
  it("merges the allowlist, refuses gated fields, and clears with null", async () => {
    const ak = await akPromise;
    const { action } = await import("../routes/api.v1.manage.property");
    const { getSettings } = await import("./overrides.server");

    // The live-traffic gate is not writable — named 422, not a silent merge.
    const gated = (await action({ request: jsonReq("/v1/manage/property", ak, "PATCH", { connected_system: "" }) } as never)) as Response;
    expect(gated.status).toBe(422);

    const badCurrency = (await action({ request: jsonReq("/v1/manage/property", ak, "PATCH", { currency: "HRK" }) } as never)) as Response;
    expect(badCurrency.status).toBe(422);
    const badLangs = (await action({ request: jsonReq("/v1/manage/property", ak, "PATCH", { languages: ["de", "fr"] }) } as never)) as Response;
    expect(badLangs.status).toBe(422); // must include the default language
    const badTz = (await action({ request: jsonReq("/v1/manage/property", ak, "PATCH", { timezone: "Mars/Olympus" }) } as never)) as Response;
    expect(badTz.status).toBe(422);

    const ok = (await action({
      request: jsonReq("/v1/manage/property", ak, "PATCH", {
        currency: "VND",
        languages: ["en", "de"],
        checkin_time: null,
        address: { city: "Hội An", country: "vn", latitude: 15.88, longitude: "108.33" },
        portal: { allow_cancel: true, cancel_deadline_value: 0, cancel_deadline_unit: "days" },
      }),
    } as never)) as Response;
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as { data: Record<string, never> };
    expect(json.data).toMatchObject({ currency: "VND", checkin_time: null, connected_system: "channex" });
    expect(json.data.address).toMatchObject({ city: "Hội An", country: "VN", latitude: "15.88", longitude: "108.33" });
    expect(json.data.portal).toMatchObject({ allow_cancel: true, cancel_deadline_value: 0, cancel_deadline_unit: "days" });

    const stored = await getSettings("p1");
    expect(stored.currency).toBe("VND");
    expect(stored.connectedSystem).toBe("channex"); // untouched by the patch
    expect("checkinTime" in stored).toBe(false); // null CLEARED the key
    expect(stored.cancelDeadlineValue).toBe(0); // meaningful zero survives
  });
});

describe("PATCH /v1/manage/property/content", () => {
  it("edits one language without touching the others, and renames on default-lang hotel_name", async () => {
    const ak = await akPromise;
    const { action } = await import("../routes/api.v1.manage.property.content");
    const { getProperty } = await import("./properties.server");

    const de = (await action({ request: jsonReq("/v1/manage/property/content?lang=de", ak, "PATCH", { description: "Neuer Text.", phone: "+49 30 1234" }) } as never)) as Response;
    const deJson = (await de.json()) as { data: { values: Record<string, string>; effective: Record<string, string> } };
    expect(deJson.data.values).toEqual({ description: "Neuer Text.", phone: "+49 30 1234" });
    expect(deJson.data.effective.hotelName).toBe("Casa Test"); // fallback intact

    // English untouched by the German edit.
    const raw = JSON.parse(store.get("overrides:p1")!);
    expect(raw.en).toEqual({ hotelName: "Casa Test", description: "English text." });

    // Clearing a translated field falls back; clearing the default name is refused.
    const cleared = (await action({ request: jsonReq("/v1/manage/property/content?lang=de", ak, "PATCH", { description: null }) } as never)) as Response;
    expect(((await cleared.json()) as { data: { values: Record<string, string> } }).data.values.description).toBeUndefined();
    const refused = (await action({ request: jsonReq("/v1/manage/property/content", ak, "PATCH", { hotel_name: null }) } as never)) as Response;
    expect(refused.status).toBe(422);

    const renamed = (await action({ request: jsonReq("/v1/manage/property/content", ak, "PATCH", { hotel_name: "Casa Moira" }) } as never)) as Response;
    expect(renamed.status).toBe(200);
    expect((await getProperty("p1"))?.name).toBe("Casa Moira");
  });
});

describe("PUT /v1/manage/taxes", () => {
  it("replaces the document with loud validation", async () => {
    const ak = await akPromise;
    const { action, loader } = await import("../routes/api.v1.manage.taxes");

    // The admin form silently drops a zero-rate tax; the API names it.
    const zeroRate = (await action({
      request: jsonReq("/v1/manage/taxes", ak, "PUT", { taxes_inclusive: true, taxes: [{ name: "VAT", rate: 0 }], fees: [] }),
    } as never)) as Response;
    expect(zeroRate.status).toBe(422);

    const badBasis = (await action({
      request: jsonReq("/v1/manage/taxes", ak, "PUT", { taxes_inclusive: true, taxes: [], fees: [{ name: "Service", kind: "percent", amount: 10, basis: "person_night" }] }),
    } as never)) as Response;
    expect(badBasis.status).toBe(422); // basis is for fixed fees only

    const oneSeason = (await action({
      request: jsonReq("/v1/manage/taxes", ak, "PUT", {
        taxes_inclusive: false,
        taxes: [],
        fees: [],
        city_tax: { enabled: true, name: "City tax", amount: 2, basis: "person_night", seasons: [{ from: "04-01", to: "10-31", amount: 8 }] },
      }),
    } as never)) as Response;
    expect(oneSeason.status).toBe(422); // one season is just the base amount

    const ok = (await action({
      request: jsonReq("/v1/manage/taxes", ak, "PUT", {
        taxes_inclusive: false,
        taxes: [{ name: "VAT", rate: 10 }],
        fees: [{ name: "Cleaning", kind: "fixed", amount: 30, taxable: true, basis: "room" }],
        city_tax: {
          enabled: true, name: "Overnight tax", amount: 2, basis: "person_night", taxable: false, children_exempt: true, max_nights: 7,
          seasons: [{ from: "11-01", to: "03-31", amount: 2 }, { from: "04-01", to: "10-31", amount: 8 }],
        },
      }),
    } as never)) as Response;
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as { data: { taxes: { rate: number }[]; fees: { basis?: string }[]; city_tax: { seasons: unknown[] } } };
    expect(json.data.taxes[0].rate).toBe(10);
    expect(json.data.fees[0].basis).toBe("room");
    expect(json.data.city_tax.seasons).toHaveLength(2);

    // Clearing city_tax with null deletes the key.
    await action({ request: jsonReq("/v1/manage/taxes", ak, "PUT", { taxes_inclusive: false, taxes: [], fees: [], city_tax: null }) } as never);
    const read = (await loader({ request: jsonReq("/v1/manage/taxes", ak, "GET") } as never)) as Response;
    expect(((await read.json()) as { data: { city_tax: unknown } }).data.city_tax).toBeNull();
  });
});
