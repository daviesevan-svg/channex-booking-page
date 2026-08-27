// Validation for the management API's website endpoints (pages, sections,
// copy, footer, style). Same rules as manage-validate.ts: loud per-field 422s,
// snake_case wire → domain shapes, unknown fields rejected.
import { MAX_FOOTER_LINKS, SOCIAL_PLATFORMS, httpUrl, isSocialPlatform, type SiteFooter } from "./footer";
import { MAX_SECTION_IMAGES, SECTION_DEFS, SECTION_TYPES, type SectionType, type SiteSection } from "./sections";

export type Errors = Record<string, string[]>;
export type Validated<T> = { ok: true; value: T } | { ok: false; errors: Errors };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const TYPE_SET = new Set<string>(SECTION_TYPES);

/** PUT sections payload → normalized SiteSection[]. `isHome` gates homeOnly
 *  section types; ids are preserved when sent, assigned by the caller when
 *  not (they key the per-language copy, so stability matters). */
export type SectionInput = Omit<SiteSection, "id"> & { id?: string };

export function validateSections(body: unknown, opts: { isHome: boolean }): Validated<SectionInput[]> {
  const errors: Errors = {};
  const fail = (f: string, m: string) => void (errors[f] ??= []).push(m);
  if (!Array.isArray(body)) return { ok: false, errors: { body: ["Must be a JSON array of sections."] } };

  const out: SectionInput[] = [];
  for (let i = 0; i < body.length; i++) {
    const s = body[i];
    const at = `[${i}]`;
    if (!isObj(s)) {
      fail(at, "Must be an object.");
      continue;
    }
    for (const k of Object.keys(s)) {
      if (!["id", "type", "hidden", "settings", "images"].includes(k)) fail(at, `Unknown field "${k}".`);
    }
    const type = s.type;
    if (typeof type !== "string" || !TYPE_SET.has(type)) {
      fail(at, `type must be one of: ${SECTION_TYPES.join(", ")}.`);
      continue;
    }
    const def = SECTION_DEFS[type as SectionType];
    if (def.homeOnly && !opts.isHome) fail(at, `"${type}" sections can only be on the home page.`);

    const hidden = s.hidden;
    if (hidden !== undefined && typeof hidden !== "boolean") fail(at, "hidden must be a boolean.");

    // Settings: only the section's own non-localized fields, typed by kind.
    // Localized fields are COPY (PATCH …/copy), not settings — the structure/
    // text split is what keeps translations from touching layout.
    const settings: Record<string, string | number | boolean> = {};
    if (s.settings !== undefined) {
      if (!isObj(s.settings)) fail(at, "settings must be an object.");
      else {
        const defs = new Map(def.fields.filter((f) => !f.localized).map((f) => [f.key, f]));
        for (const [k, v] of Object.entries(s.settings)) {
          const fd = defs.get(k);
          if (!fd) {
            const localized = def.fields.some((f) => f.key === k && f.localized);
            fail(at, localized ? `"${k}" is text — edit it via the page copy endpoint, not settings.` : `Unknown setting "${k}" for a "${type}" section.`);
            continue;
          }
          if (fd.kind === "select" && (typeof v !== "string" || !(fd.options ?? []).includes(v))) fail(at, `"${k}" must be one of: ${(fd.options ?? []).join(", ")}.`);
          else if (fd.kind === "number" && (typeof v !== "number" || (fd.min !== undefined && v < fd.min) || (fd.max !== undefined && v > fd.max))) {
            fail(at, `"${k}" must be a number${fd.min !== undefined ? ` ≥ ${fd.min}` : ""}${fd.max !== undefined ? ` ≤ ${fd.max}` : ""}.`);
          } else if (fd.kind === "boolean" && typeof v !== "boolean") fail(at, `"${k}" must be a boolean.`);
          else if (fd.kind === "text" && typeof v !== "string") fail(at, `"${k}" must be a string.`);
          else settings[k] = v as string | number | boolean;
        }
      }
    }

    let images: SiteSection["images"];
    if (s.images !== undefined) {
      if (!def.images) fail(at, `"${type}" sections don't hold images.`);
      else if (!Array.isArray(s.images)) fail(at, "images must be an array.");
      else if (s.images.length > MAX_SECTION_IMAGES) fail(at, `At most ${MAX_SECTION_IMAGES} images per section.`);
      else {
        images = [];
        for (const img of s.images) {
          if (!isObj(img) || typeof img.url !== "string" || !img.url.startsWith("/images/")) {
            fail(at, "Each image needs a url that is an /images/… path (upload via POST /v1/manage/images).");
            break;
          }
          images.push({ id: typeof img.id === "string" && img.id.trim() ? img.id.trim() : crypto.randomUUID(), url: img.url });
        }
      }
    }

    out.push({
      id: typeof s.id === "string" && s.id.trim() ? s.id.trim() : undefined,
      type: type as SectionType,
      ...(hidden === true ? { hidden: true } : {}),
      settings,
      ...(images ? { images } : {}),
    });
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: out };
}

/** PATCH copy payload: key → string | null, keys restricted to what the page
 *  owns (`validKeys`) so an agent gets steered to the real key list instead of
 *  writing text nothing renders. */
export function validateCopyPatch(body: unknown, validKeys: Set<string>): Validated<Record<string, string | null>> {
  const errors: Errors = {};
  if (!isObj(body)) return { ok: false, errors: { body: ["Must be a JSON object of copyKey → text (null clears)."] } };
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!validKeys.has(k)) {
      (errors[k] ??= []).push("Not a copy key of this page — GET the page's copy endpoint for the valid keys.");
      continue;
    }
    if (v === null) out[k] = null;
    else if (typeof v !== "string") (errors[k] ??= []).push("Must be a string or null.");
    else out[k] = v.trim() || null;
  }
  if (!Object.keys(errors).length && Object.keys(out).length === 0) errors.body = ["No fields to update."];
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: out };
}

/** PUT footer payload — structure + ONE language's text, sparse over the
 *  currently stored footer (the route supplies it). */
export interface FooterPutInput {
  footer: SiteFooter;
  /** blurb + link labels for the requested language. null clears. */
  blurb?: string | null;
  /** linkId → label for THIS language (labels ride the links array on the wire). */
  labels: Record<string, string | null>;
}

export function validateFooterPut(body: unknown, current: SiteFooter): Validated<FooterPutInput> {
  const errors: Errors = {};
  const fail = (f: string, m: string) => void (errors[f] ??= []).push(m);
  if (!isObj(body)) return { ok: false, errors: { body: ["Must be a JSON object."] } };
  for (const k of Object.keys(body)) {
    if (!["show_contact", "social", "links", "blurb"].includes(k)) fail(k, "Unknown field.");
  }

  const footer: SiteFooter = { ...current };
  if (body.show_contact !== undefined) {
    if (typeof body.show_contact !== "boolean") fail("show_contact", "Must be a boolean.");
    else footer.showContact = body.show_contact;
  }

  if (body.social !== undefined) {
    if (!isObj(body.social)) fail("social", "Must be an object of platform → profile URL (null removes).");
    else {
      const social: SiteFooter["social"] = { ...(current.social ?? {}) };
      for (const [platform, url] of Object.entries(body.social)) {
        if (!isSocialPlatform(platform)) {
          fail("social", `Unknown platform "${platform}" — one of: ${SOCIAL_PLATFORMS.join(", ")}.`);
          continue;
        }
        if (url === null) delete social[platform];
        else if (typeof url !== "string" || !httpUrl(url)) fail("social", `"${platform}" must be an http(s) URL or null.`);
        else social[platform] = httpUrl(url);
      }
      footer.social = social;
    }
  }

  const labels: Record<string, string | null> = {};
  if (body.links !== undefined) {
    if (!Array.isArray(body.links)) fail("links", "Must be an array (it REPLACES the link list; labels are per-language).");
    else if (body.links.length > MAX_FOOTER_LINKS) fail("links", `At most ${MAX_FOOTER_LINKS} links.`);
    else {
      const rawLinks = body.links as unknown[];
      const links: NonNullable<SiteFooter["links"]> = [];
      for (let i = 0; i < rawLinks.length; i++) {
        const l = rawLinks[i];
        if (!isObj(l) || typeof l.url !== "string" || !httpUrl(l.url)) {
          fail(`links[${i}]`, "Needs an http(s) url.");
          continue;
        }
        const id = typeof l.id === "string" && l.id.trim() ? l.id.trim() : crypto.randomUUID();
        links.push({ id, url: httpUrl(l.url)! });
        if (l.label !== undefined) {
          if (l.label !== null && typeof l.label !== "string") fail(`links[${i}]`, "label must be a string or null.");
          else labels[id] = typeof l.label === "string" ? l.label.trim() || null : null;
        }
      }
      footer.links = links;
    }
  }

  let blurb: string | null | undefined;
  if (body.blurb !== undefined) {
    if (body.blurb !== null && typeof body.blurb !== "string") fail("blurb", "Must be a string or null.");
    else blurb = typeof body.blurb === "string" ? body.blurb.trim() || null : null;
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { footer, blurb, labels } };
}
