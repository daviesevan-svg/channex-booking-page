// Property photo gallery storage — one KV key per property (`gallery:{pid}`).
//
// A gallery is an ORDERED list, so per-item keys (the pattern used for
// collections) would need a separate order index to rebuild it — more moving
// parts than the problem deserves. The trade-off: writes are read-modify-write,
// so two admins editing the same property's gallery at the same instant can
// lose one edit. That is a per-property, human-paced form, not a cross-tenant
// list, so the blast radius is one lost save rather than silently dropped rows.
// `addImages` takes the whole batch in a single write for that reason — never
// call it in a loop.

import { getConfigKV } from "./config.server";
import { DEFAULT_LANG } from "./content";
import {
  applyOrder,
  emptyGallery,
  MAX_GALLERY_IMAGES,
  resolveGallery,
  type Gallery,
  type GalleryText,
  type ResolvedGalleryImage,
} from "./gallery";

const key = (pid: string) => `gallery:${pid}`;

async function read(pid: string): Promise<Gallery> {
  const kv = getConfigKV();
  if (!kv) return emptyGallery();
  const raw = await kv.get(key(pid));
  if (!raw) return emptyGallery();
  try {
    const parsed = JSON.parse(raw) as Partial<Gallery>;
    return { images: parsed.images ?? [], text: parsed.text ?? {} };
  } catch {
    return emptyGallery();
  }
}

async function write(pid: string, gallery: Gallery): Promise<void> {
  const kv = getConfigKV();
  if (kv) await kv.put(key(pid), JSON.stringify(gallery));
}

/** The raw gallery — for the admin editor, which edits one language at a time. */
export function getGallery(pid: string): Promise<Gallery> {
  return read(pid);
}

/** Guest-facing: images in order, with alt/caption resolved for `lang`. */
export async function getGalleryFor(
  pid: string,
  lang: string = DEFAULT_LANG,
): Promise<ResolvedGalleryImage[]> {
  return resolveGallery(await read(pid), lang, DEFAULT_LANG);
}

/** Append uploaded images. Pass the whole batch — one read-modify-write. */
export async function addImages(
  pid: string,
  urls: string[],
): Promise<{ added: number; skipped: number }> {
  if (!urls.length) return { added: 0, skipped: 0 };
  const gallery = await read(pid);
  const room = Math.max(0, MAX_GALLERY_IMAGES - gallery.images.length);
  const take = urls.slice(0, room);
  for (const url of take) gallery.images.push({ id: crypto.randomUUID(), url });
  await write(pid, gallery);
  return { added: take.length, skipped: urls.length - take.length };
}

/** Remove one image. Returns its url, for `queueImageCleanup` — dropping the
 *  row here is the only thing that ever stops referencing the R2 object. */
export async function removeImage(pid: string, id: string): Promise<string[]> {
  const gallery = await read(pid);
  const gone = gallery.images.find((i) => i.id === id);
  gallery.images = gallery.images.filter((i) => i.id !== id);
  // Drop the orphaned text in every language, so a re-uploaded photo can't
  // inherit a caption from a deleted one (ids are fresh, but keep KV tidy).
  for (const lang of Object.keys(gallery.text)) delete gallery.text[lang][id];
  await write(pid, gallery);
  return gone ? [gone.url] : [];
}

/** Save order and the alt/caption for ONE language in a single write. */
export async function saveGalleryLang(
  pid: string,
  lang: string,
  order: string[],
  text: Record<string, GalleryText>,
): Promise<void> {
  const gallery = await read(pid);
  gallery.images = applyOrder(gallery.images, order);
  const known = new Set(gallery.images.map((i) => i.id));
  const next: Record<string, GalleryText> = {};
  for (const [id, t] of Object.entries(text)) {
    if (!known.has(id)) continue; // ignore rows for images deleted meanwhile
    const alt = t.alt?.trim();
    const caption = t.caption?.trim();
    if (alt || caption) next[id] = { ...(alt ? { alt } : {}), ...(caption ? { caption } : {}) };
  }
  gallery.text[lang] = next;
  await write(pid, gallery);
}
