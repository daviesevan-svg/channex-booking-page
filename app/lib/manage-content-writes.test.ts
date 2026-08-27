import { describe, expect, it, vi } from "vitest";

// Gallery + funnel-content endpoints over in-memory KV. Pins: gallery replace
// keeps ids (and so captions in every language) while pruning removed images'
// text, per-language text edits stay in their language, hero_image survives a
// text-only save and is refused off the default language, funnel page fields
// are validated against the page definition, and facility lines stay
// whole-list per language.

const store = new Map<string, string>();
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
};

vi.mock("cloudflare:workers", () => ({
  env: { CONFIG_KV: kv },
  waitUntil: () => {},
}));

const req = (path: string, key: string, method = "GET", body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function setup() {
  store.set("properties", JSON.stringify([{ id: "p1", name: "Casa Test" }]));
  store.set("settings:p1", JSON.stringify({}));
  const { issueApiKey } = await import("./api-auth.server");
  const { raw } = await issueApiKey("p1", { label: "g", mode: "live", scope: "manage" });
  return raw;
}
const akPromise = setup();

describe("gallery", () => {
  it("replaces the list preserving kept ids' captions, edits text per language", async () => {
    const ak = await akPromise;
    const gallery = await import("../routes/api.v1.manage.gallery");
    const text = await import("../routes/api.v1.manage.gallery.text");

    const external = (await gallery.action({ request: req("/v1/manage/gallery", ak, "PUT", [{ url: "https://cdn.example/x.jpg" }]) } as never)) as Response;
    expect(external.status).toBe(422);

    const set = (await gallery.action({
      request: req("/v1/manage/gallery", ak, "PUT", { images: [{ url: "/images/gallery/a.jpg" }, { url: "/images/gallery/b.jpg" }] }),
    } as never)) as Response;
    const ids = ((await set.json()) as { data: { images: { id: string }[] } }).data.images.map((i) => i.id);

    // Captions in two languages for image A.
    await text.action({ request: req("/v1/manage/gallery/text", ak, "PATCH", { [ids[0]]: { alt: "Pool at dusk" } }) } as never);
    await text.action({ request: req("/v1/manage/gallery/text?lang=de", ak, "PATCH", { text: { [ids[0]]: { alt: "Pool bei Dämmerung", caption: "Der Pool" } } }) } as never);

    const badId = (await text.action({ request: req("/v1/manage/gallery/text", ak, "PATCH", { ghost: { alt: "x" } }) } as never)) as Response;
    expect(badId.status).toBe(422);

    // Reorder + drop B + add C in one PUT: A keeps BOTH languages' text.
    const replaced = (await gallery.action({
      request: req("/v1/manage/gallery", ak, "PUT", { images: [{ url: "/images/gallery/c.jpg" }, { id: ids[0], url: "/images/gallery/a.jpg" }] }),
    } as never)) as Response;
    const after = ((await replaced.json()) as { data: { images: { id: string; url: string }[] } }).data.images;
    expect(after.map((i) => i.url)).toEqual(["/images/gallery/c.jpg", "/images/gallery/a.jpg"]);
    expect(after[1].id).toBe(ids[0]);

    const raw = JSON.parse(store.get("gallery:p1")!);
    expect(raw.text.de[ids[0]]).toEqual({ alt: "Pool bei Dämmerung", caption: "Der Pool" });
    expect(raw.text.en[ids[0]]).toEqual({ alt: "Pool at dusk" });
    expect(JSON.stringify(raw)).not.toContain("/images/gallery/b.jpg");

    // Clearing one field, keeping the other.
    await text.action({ request: req("/v1/manage/gallery/text?lang=de", ak, "PATCH", { [ids[0]]: { caption: null } }) } as never);
    const raw2 = JSON.parse(store.get("gallery:p1")!);
    expect(raw2.text.de[ids[0]]).toEqual({ alt: "Pool bei Dämmerung" });
  });
});

describe("search/hero content", () => {
  it("edits one language sparsely, keeps hero_image safe, gates it to the default language", async () => {
    const ak = await akPromise;
    const search = await import("../routes/api.v1.manage.content.search");

    await search.action({ request: req("/v1/manage/content/search", ak, "PATCH", { heading: "Stay with us", hero_image: "/images/home/hero.jpg" }) } as never);
    // A German text-only save must not wipe the hero image.
    await search.action({ request: req("/v1/manage/content/search?lang=de", ak, "PATCH", { heading: "Bleib bei uns" }) } as never);
    const view = (await search.loader({ request: req("/v1/manage/content/search?lang=de", ak) } as never)) as Response;
    const de = (await view.json()) as { data: { values: { heading: string }; effective: { heading: string }; hero_image: string } };
    expect(de.data.values.heading).toBe("Bleib bei uns");
    expect(de.data.hero_image).toBe("/images/home/hero.jpg");

    const heroOffDefault = (await search.action({ request: req("/v1/manage/content/search?lang=de", ak, "PATCH", { hero_image: null }) } as never)) as Response;
    expect(heroOffDefault.status).toBe(422);

    const badHighlights = (await search.action({ request: req("/v1/manage/content/search", ak, "PATCH", { highlights: [{ title: "Only title" }] }) } as never)) as Response;
    expect(badHighlights.status).toBe(422);

    // Clearing the German heading falls back to English.
    await search.action({ request: req("/v1/manage/content/search?lang=de", ak, "PATCH", { heading: null }) } as never);
    const after = (await search.loader({ request: req("/v1/manage/content/search?lang=de", ak) } as never)) as Response;
    const afterJson = (await after.json()) as { data: { values: { heading: string | null }; effective: { heading: string } } };
    expect(afterJson.data.values.heading).toBeNull();
    expect(afterJson.data.effective.heading).toBe("Stay with us");
  });
});

describe("funnel page copy + facility lines", () => {
  it("validates fields against the page definition and stays per-language", async () => {
    const ak = await akPromise;
    const funnel = await import("../routes/api.v1.manage.content.pages.$id");

    const badPage = (await funnel.loader({ request: req("/v1/manage/content/pages/ghost", ak), params: { id: "ghost" } } as never)) as Response;
    expect(badPage.status).toBe(404);

    const view = (await funnel.loader({ request: req("/v1/manage/content/pages/checkout", ak), params: { id: "checkout" } } as never)) as Response;
    const fields = ((await view.json()) as { data: { fields: { key: string }[] } }).data.fields;
    expect(fields.length).toBeGreaterThan(0);
    const fieldKey = fields[0].key;

    const badField = (await funnel.action({
      request: req("/v1/manage/content/pages/checkout", ak, "PATCH", { made_up_field: "x" }),
      params: { id: "checkout" },
    } as never)) as Response;
    expect(badField.status).toBe(422);

    const wrote = (await funnel.action({
      request: req("/v1/manage/content/pages/checkout?lang=de", ak, "PATCH", { [fieldKey]: "Deutsch." }),
      params: { id: "checkout" },
    } as never)) as Response;
    const wroteJson = (await wrote.json()) as { data: { values: Record<string, string> } };
    expect(wroteJson.data.values[fieldKey]).toBe("Deutsch.");
    const raw = JSON.parse(store.get("content:p1")!);
    expect(raw.en?.pages?.checkout?.[fieldKey]).toBeUndefined(); // German edit stayed German

    const facilities = await import("../routes/api.v1.manage.content.facilities");
    await facilities.action({ request: req("/v1/manage/content/facilities", ak, "PUT", ["Pool", "Sauna"]) } as never);
    await facilities.action({ request: req("/v1/manage/content/facilities?lang=de", ak, "PUT", { lines: ["Pool", "Sauna (Deutsch)"] }) } as never);
    const de = (await facilities.loader({ request: req("/v1/manage/content/facilities?lang=de", ak) } as never)) as Response;
    expect(((await de.json()) as { data: { effective: string[] } }).data.effective).toEqual(["Pool", "Sauna (Deutsch)"]);
    // Clearing German falls back to the WHOLE English list.
    await facilities.action({ request: req("/v1/manage/content/facilities?lang=de", ak, "PUT", []) } as never);
    const cleared = (await facilities.loader({ request: req("/v1/manage/content/facilities?lang=de", ak) } as never)) as Response;
    expect(((await cleared.json()) as { data: { effective: string[]; values: string[] } }).data).toMatchObject({ values: [], effective: ["Pool", "Sauna"] });
  });
});
