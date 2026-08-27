import { describe, expect, it, vi } from "vitest";

// Website endpoints: real route loaders/actions over in-memory KV. What these
// pin: the structure/text split (a sections PUT can't touch copy; a copy PATCH
// can't touch structure), copy keys restricted to what the page owns, the
// one-language scoping of copy edits, stable-section-id preservation, footer
// dead-link label pruning across languages, and the page lifecycle.

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
  store.set("settings:p1", JSON.stringify({ websiteEnabled: true }));
  const { issueApiKey } = await import("./api-auth.server");
  const { raw } = await issueApiKey("p1", { label: "w", mode: "live", scope: "manage" });
  return raw;
}
const akPromise = setup();

describe("website pages", () => {
  it("creates a page, shapes its sections, writes copy per language, and deletes it", async () => {
    const ak = await akPromise;
    const site = await import("../routes/api.v1.manage.site");
    const pages = await import("../routes/api.v1.manage.site.pages");
    const page = await import("../routes/api.v1.manage.site.pages.$id");
    const sections = await import("../routes/api.v1.manage.site.pages.$id.sections");
    const copy = await import("../routes/api.v1.manage.site.pages.$id.copy");

    // Reserved slug is the site.server error surfaced as a 422.
    const reserved = (await pages.action({ request: req("/v1/manage/site/pages", ak, "POST", { slug: "admin", title: "Nope" }) } as never)) as Response;
    expect(reserved.status).toBe(422);

    const created = (await pages.action({ request: req("/v1/manage/site/pages", ak, "POST", { slug: "dining", title: "Dining" }) } as never)) as Response;
    expect(created.status).toBe(201);
    const pageId = ((await created.json()) as { data: { id: string } }).data.id;

    // The site view lists it beside home.
    const overview = (await site.loader({ request: req("/v1/manage/site", ak) } as never)) as Response;
    const overviewJson = (await overview.json()) as { data: { pages: { id: string }[]; style: string } };
    expect(overviewJson.data.pages.map((p) => p.id)).toContain(pageId);

    // Structure: homeOnly sections are refused off-home; text-in-settings is
    // steered to the copy endpoint.
    const homeOnly = (await sections.action({
      request: req(`/v1/manage/site/pages/${pageId}/sections`, ak, "PUT", [{ type: "hero" }]),
      params: { id: pageId },
    } as never)) as Response;
    expect(homeOnly.status).toBe(422);

    const shaped = (await sections.action({
      request: req(`/v1/manage/site/pages/${pageId}/sections`, ak, "PUT", { sections: [{ type: "richText" }, { type: "gallery" }] }),
      params: { id: pageId },
    } as never)) as Response;
    expect(shaped.status).toBe(200);
    const shapedJson = (await shaped.json()) as { data: { sections: { id: string; type: string }[] } };
    const richId = shapedJson.data.sections.find((s) => s.type === "richText")!.id;

    // Copy: keys outside the page's own set are named 422s; valid writes stick
    // to ONE language.
    const pageView = (await page.loader({ request: req(`/v1/manage/site/pages/${pageId}?lang=de`, ak), params: { id: pageId } } as never)) as Response;
    const { copy_keys } = ((await pageView.json()) as { data: { copy_keys: string[] } }).data;
    const bodyKey = copy_keys.find((k) => k.startsWith(`${richId}.`))!;

    const badKey = (await copy.action({
      request: req(`/v1/manage/site/pages/${pageId}/copy?lang=de`, ak, "PATCH", { "hero.heading": "Nope" }),
      params: { id: pageId },
    } as never)) as Response;
    expect(badKey.status).toBe(422);

    const wrote = (await copy.action({
      request: req(`/v1/manage/site/pages/${pageId}/copy?lang=de`, ak, "PATCH", { copy: { [bodyKey]: "Deutscher Absatz." } }),
      params: { id: pageId },
    } as never)) as Response;
    expect(((await wrote.json()) as { data: { copy: Record<string, string> } }).data.copy[bodyKey]).toBe("Deutscher Absatz.");

    // The German write didn't touch English (the default-language title from
    // creation is still there), and a second sections save with the SAME ids
    // didn't orphan the German text.
    const enView = (await copy.loader({ request: req(`/v1/manage/site/pages/${pageId}/copy`, ak), params: { id: pageId } } as never)) as Response;
    const enCopy = ((await enView.json()) as { data: { copy: Record<string, string> } }).data.copy;
    expect(Object.values(enCopy)).toContain("Dining");

    await sections.action({
      request: req(`/v1/manage/site/pages/${pageId}/sections`, ak, "PUT", { sections: shapedJson.data.sections }),
      params: { id: pageId },
    } as never);
    const deAfter = (await copy.loader({ request: req(`/v1/manage/site/pages/${pageId}/copy?lang=de`, ak), params: { id: pageId } } as never)) as Response;
    expect(((await deAfter.json()) as { data: { copy: Record<string, string> } }).data.copy[bodyKey]).toBe("Deutscher Absatz.");

    // Slug/nav patch; home refuses.
    const renamed = (await page.action({ request: req(`/v1/manage/site/pages/${pageId}`, ak, "PATCH", { slug: "restaurant", nav: false }), params: { id: pageId } } as never)) as Response;
    expect(renamed.status).toBe(200);
    const homePatch = (await page.action({ request: req(`/v1/manage/site/pages/home`, ak, "PATCH", { slug: "x" }), params: { id: "home" } } as never)) as Response;
    expect(homePatch.status).toBe(422);

    // Delete removes the page and its copy everywhere.
    const deleted = (await page.action({ request: req(`/v1/manage/site/pages/${pageId}`, ak, "DELETE"), params: { id: pageId } } as never)) as Response;
    expect(((await deleted.json()) as { deleted: boolean }).deleted).toBe(true);
    const siteRaw = JSON.parse(store.get("site:p1")!);
    expect(JSON.stringify(siteRaw)).not.toContain("Deutscher Absatz.");
  });

  it("switches the layout style without touching content", async () => {
    const ak = await akPromise;
    const site = await import("../routes/api.v1.manage.site");
    const bad = (await site.action({ request: req("/v1/manage/site", ak, "PATCH", { style: "brutalist" }) } as never)) as Response;
    expect(bad.status).toBe(422);
    const before = store.get("site:p1");
    const ok = (await site.action({ request: req("/v1/manage/site", ak, "PATCH", { style: "editorial" }) } as never)) as Response;
    expect(((await ok.json()) as { data: { style: string } }).data.style).toBe("editorial");
    const after = JSON.parse(store.get("site:p1")!);
    expect(after.style).toBe("editorial");
    expect(JSON.stringify(after.pages)).toBe(JSON.stringify(JSON.parse(before!).pages)); // content untouched
  });
});

describe("footer", () => {
  it("edits structure + one language's labels, pruning removed links' labels everywhere", async () => {
    const ak = await akPromise;
    const footer = await import("../routes/api.v1.manage.site.footer");

    const badUrl = (await footer.action({ request: req("/v1/manage/site/footer", ak, "PUT", { links: [{ url: "javascript:alert(1)", label: "X" }] }) } as never)) as Response;
    expect(badUrl.status).toBe(422);
    const badPlatform = (await footer.action({ request: req("/v1/manage/site/footer", ak, "PUT", { social: { myspace: "https://x.example" } }) } as never)) as Response;
    expect(badPlatform.status).toBe(422);

    const set = (await footer.action({
      request: req("/v1/manage/site/footer", ak, "PUT", {
        show_contact: true,
        social: { instagram: "https://instagram.com/casatest" },
        links: [{ url: "https://example.com/spa", label: "Spa" }],
        blurb: "A calm place.",
      }),
    } as never)) as Response;
    expect(set.status).toBe(200);
    const linkId = ((await set.json()) as { data: { links: { id: string }[] } }).data.links[0].id;

    // German label for the SAME link id (structure untouched by omission).
    await footer.action({
      request: req("/v1/manage/site/footer?lang=de", ak, "PUT", { links: [{ id: linkId, url: "https://example.com/spa", label: "Wellness" }] }),
    } as never);
    const de = (await footer.loader({ request: req("/v1/manage/site/footer?lang=de", ak) } as never)) as Response;
    expect(((await de.json()) as { data: { links: { label: string }[] } }).data.links[0].label).toBe("Wellness");
    const en = (await footer.loader({ request: req("/v1/manage/site/footer", ak) } as never)) as Response;
    const enJson = (await en.json()) as { data: { links: { label: string }[]; blurb: string; social: Record<string, string> } };
    expect(enJson.data.links[0].label).toBe("Spa");
    expect(enJson.data.blurb).toBe("A calm place.");
    expect(enJson.data.social.instagram).toContain("instagram.com");

    // Removing the link drops its label in EVERY language.
    await footer.action({ request: req("/v1/manage/site/footer", ak, "PUT", { links: [] }) } as never);
    const raw = JSON.parse(store.get("site:p1")!);
    expect(JSON.stringify(raw.footerCopy ?? {})).not.toContain("Wellness");
  });
});
