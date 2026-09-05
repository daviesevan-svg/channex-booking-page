import { describe, expect, it, vi } from "vitest";

// One transformation per (image, width) — whatever the URL looks like.
//
// The Worker cache used to be keyed by the whole request URL, so anything the
// URL carried that the output does NOT depend on bought a second entry and a
// second billed transformation: a tracking parameter appended to an <img src>,
// or `w=0300` used somewhere alongside `w=300`. This drives the real loader
// against a stand-in cache and asserts on the keys it actually stores under.

/** Keys the loader put in the cache, in order. */
const stored: string[] = [];
const cacheStore = new Map<string, Response>();
let transforms = 0;

const fakeCache = {
  async match(req: Request) {
    return cacheStore.get(req.url)?.clone() ?? undefined;
  },
  async put(req: Request, res: Response) {
    stored.push(req.url);
    cacheStore.set(req.url, res);
  },
};
vi.stubGlobal("caches", { open: async () => fakeCache });

const bucket = {
  async get() {
    return { body: "IMAGE-BYTES", httpEtag: '"e1"', httpMetadata: { contentType: "image/jpeg" } };
  },
};

const transformer = {
  input() {
    return this;
  },
  transform() {
    return this;
  },
  output() {
    transforms++;
    return Promise.resolve({ response: () => new Response("WEBP-BYTES", { headers: { "Content-Type": "image/webp" } }) });
  },
};

vi.mock("cloudflare:workers", () => ({
  env: { IMAGES: bucket, IMAGE_TRANSFORM: transformer },
  waitUntil: (p: Promise<unknown>) => p,
}));

const KEY = "prop/8a1f-photo.jpg";
const load = async (url: string) => {
  const { loader } = await import("~/routes/image");
  return (await loader({
    params: { "*": KEY },
    request: new Request(url),
    context: {} as never,
  } as never)) as Response;
};

const ORIGIN = "https://book.roompanda.com";

describe("resized image caching", () => {
  it("serves a second, differently-spelled request from the first transformation", async () => {
    const first = await load(`${ORIGIN}/images/${KEY}?w=320`);
    expect(first.headers.get("X-Image-Transform")).toBe("miss");
    expect(transforms).toBe(1);

    // Same image, same width — a campaign parameter on the src and a padded
    // number are not different pictures.
    for (const url of [`${ORIGIN}/images/${KEY}?w=320&utm_source=newsletter`, `${ORIGIN}/images/${KEY}?w=0320`]) {
      const again = await load(url);
      expect(again.headers.get("X-Image-Transform")).toBe("hit");
    }
    expect(transforms).toBe(1);
    // One entry, not three.
    expect(new Set(stored).size).toBe(1);
  });

  it("keys on the origin, so one host's cache can't answer for another's", async () => {
    stored.length = 0;
    await load(`${ORIGIN}/images/${KEY}?w=480`);
    await load(`https://book.otherpms.com/images/${KEY}?w=480`);
    expect(new Set(stored).size).toBe(2);
  });

  it("still keeps different widths apart", async () => {
    stored.length = 0;
    await load(`${ORIGIN}/images/${KEY}?w=640`);
    await load(`${ORIGIN}/images/${KEY}?w=960`);
    expect(new Set(stored).size).toBe(2);
  });
});
