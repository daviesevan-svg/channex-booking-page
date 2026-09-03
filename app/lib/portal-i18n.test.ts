import { describe, expect, it, vi } from "vitest";

// The guest portal's after-deadline message is guest-facing copy on a page that
// shows the admin's "Editing: [language]" switcher, so it has to be editable
// per language. It used to be a single global settings field: typing the German
// version and saving overwrote the English one, which hotels reported as "I
// can't translate this text". These pin the split storage — default language in
// settings, translations in the content store — and, above all, that a
// translation save never touches the original.

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

// The admin route itself, with the session plumbing stubbed — the wiring IS the
// bug (which store each tab's save lands in), so the store test alone would not
// have caught it.
vi.mock("../lib/auth.server", () => ({ requireAdmin: async () => "owner@example.com" }));
vi.mock("../lib/properties.server", () => ({
  currentPropertyId: async () => "p1",
  isOwnerOrSuper: async () => true,
}));

const PID = "p1";
const BASE = "Call us on +44 1267 237037 and we'll do what we can.";
const DE = "Rufen Sie uns unter +44 1267 237037 an.";

function seed() {
  store.clear();
  store.set(`settings:${PID}`, JSON.stringify({ allowCancel: true, afterDeadlineMessage: BASE }));
}

/** The portal form as the admin posts it, for one language tab. */
function portalForm(lang: string, message: string): FormData {
  const f = new FormData();
  f.append("lang", lang);
  f.append("allowCancel", "on");
  f.append("cancelDeadlineValue", "24");
  f.append("cancelDeadlineUnit", "hours");
  f.append("afterDeadlineMessage", message);
  return f;
}

describe("portal after-deadline message", () => {
  it("saves the default language into settings, where the management API reads it", async () => {
    seed();
    const { getPortalMessage, getPortalMessageRaw, getSettings, savePortalSettings } = await import("./overrides.server");
    await savePortalSettings(PID, portalForm("en", "Updated English copy."), { persistMessage: true });
    expect((await getSettings(PID)).afterDeadlineMessage).toBe("Updated English copy.");
    expect(await getPortalMessageRaw(PID, "en")).toBe("Updated English copy.");
    expect(await getPortalMessage(PID, "en")).toBe("Updated English copy.");
  });

  it("a translation tab stores the translation and leaves the original alone", async () => {
    seed();
    const { getPortalMessage, getPortalMessageRaw, getSettings, savePortalSettings, savePortalTranslation } =
      await import("./overrides.server");

    // Exactly what the German tab posts: the textarea holds German text.
    await savePortalSettings(PID, portalForm("de", DE), { persistMessage: false });
    await savePortalTranslation(PID, "de", DE);

    // The regression: English is untouched.
    expect((await getSettings(PID)).afterDeadlineMessage).toBe(BASE);
    expect(await getPortalMessage(PID, "en")).toBe(BASE);
    // German now has its own text; the editor shows it raw.
    expect(await getPortalMessage(PID, "de")).toBe(DE);
    expect(await getPortalMessageRaw(PID, "de")).toBe(DE);
    // The language-independent settings still saved from that tab.
    expect((await getSettings(PID)).cancelDeadlineValue).toBe(24);
  });

  it("shows an untranslated language the default text, but an EMPTY editor field", async () => {
    seed();
    const { getPortalMessage, getPortalMessageRaw } = await import("./overrides.server");
    // Guests never see a blank: they fall back to the hotel's own default copy.
    expect(await getPortalMessage(PID, "fr")).toBe(BASE);
    // The editor must not prefill it — a prefilled field reads as "translated".
    expect(await getPortalMessageRaw(PID, "fr")).toBeUndefined();
  });

  it("clearing a translation falls back to the default language again", async () => {
    seed();
    const { getPortalMessage, getPortalMessageRaw, savePortalTranslation } = await import("./overrides.server");
    await savePortalTranslation(PID, "de", DE);
    expect(await getPortalMessage(PID, "de")).toBe(DE);
    await savePortalTranslation(PID, "de", "   ");
    expect(await getPortalMessageRaw(PID, "de")).toBeUndefined();
    expect(await getPortalMessage(PID, "de")).toBe(BASE);
  });

  it("returns undefined when the hotel never wrote one (portal shows its built-in string)", async () => {
    store.clear();
    store.set(`settings:${PID}`, JSON.stringify({ allowCancel: true }));
    const { getPortalMessage } = await import("./overrides.server");
    expect(await getPortalMessage(PID, "en")).toBeUndefined();
    expect(await getPortalMessage(PID, "de")).toBeUndefined();
  });

  it("survives a save of the same language's other content", async () => {
    seed();
    const { getPortalMessage, savePortalTranslation, saveSearchContent, getSearchContentRaw } =
      await import("./overrides.server");
    await savePortalTranslation(PID, "de", DE);
    // The content entry is shared with the search copy — one section's save
    // must not drop the other's.
    await saveSearchContent(PID, "de", { heading: "Buchen Sie Ihren Aufenthalt" });
    expect(await getPortalMessage(PID, "de")).toBe(DE);
    expect((await getSearchContentRaw(PID, "de")).heading).toBe("Buchen Sie Ihren Aufenthalt");
  });
});

describe("the admin Portal page's wiring", () => {
  const post = (lang: string, message: string) =>
    ({ request: new Request("http://localhost/admin/portal", { method: "POST", body: portalForm(lang, message) }) }) as never;
  const get = (lang?: string) =>
    ({ request: new Request(`http://localhost/admin/portal${lang ? `?lang=${lang}` : ""}`) }) as never;

  it("routes each tab's save to the right store and never crosses them", async () => {
    seed();
    const portal = await import("../routes/admin/portal");
    const { getSettings, getPortalMessage } = await import("./overrides.server");

    // German tab.
    await portal.action(post("de", DE));
    expect((await getSettings("p1")).afterDeadlineMessage).toBe(BASE); // untouched
    expect(await getPortalMessage("p1", "de")).toBe(DE);

    // English tab still edits the original, leaving German in place.
    await portal.action(post("en", "New English copy."));
    expect((await getSettings("p1")).afterDeadlineMessage).toBe("New English copy.");
    expect(await getPortalMessage("p1", "de")).toBe(DE);
  });

  it("loads the tab's own text — empty on an untranslated language", async () => {
    seed();
    const portal = await import("../routes/admin/portal");
    await portal.action(post("de", DE));

    const en = (await portal.loader(get())) as { lang: string; message: string };
    expect(en).toMatchObject({ lang: "en", message: BASE });
    const de = (await portal.loader(get("de"))) as { lang: string; message: string };
    expect(de).toMatchObject({ lang: "de", message: DE });
    const fr = (await portal.loader(get("fr"))) as { lang: string; message: string };
    expect(fr).toMatchObject({ lang: "fr", message: "" });
  });

  it("a bogus ?lang cannot invent a language entry", async () => {
    seed();
    const portal = await import("../routes/admin/portal");
    // pickLang falls back to the default, so this edits English — not "zz".
    await portal.action(post("zz", "Fallback copy."));
    const { getSettings } = await import("./overrides.server");
    expect((await getSettings("p1")).afterDeadlineMessage).toBe("Fallback copy.");
    expect(JSON.parse(store.get("content:p1") ?? "{}").zz).toBeUndefined();
  });
});
