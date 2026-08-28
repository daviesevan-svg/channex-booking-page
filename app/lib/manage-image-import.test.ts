import { describe, expect, it, vi } from "vitest";

// Import-by-URL: the SSRF gate (webhook-grade, re-checked per redirect hop),
// the image/size rules, and website_enabled's graduation into the property
// PATCH allowlist.

const store = new Map<string, string>();
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
};
const r2Puts: string[] = [];
const bucket = { put: async (key: string) => void r2Puts.push(key) };

vi.mock("cloudflare:workers", () => ({
  env: { CONFIG_KV: kv, IMAGES: bucket },
  waitUntil: () => {},
}));

const jsonReq = (path: string, key: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function setup() {
  store.set("properties", JSON.stringify([{ id: "p1", name: "Casa Test" }]));
  store.set("settings:p1", JSON.stringify({}));
  const { issueApiKey } = await import("./api-auth.server");
  const { raw } = await issueApiKey("p1", { label: "img", mode: "live", scope: "manage" });
  return raw;
}
const akPromise = setup();

const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } });

describe("POST /v1/manage/images/import", () => {
  it("refuses non-public targets, follows the redirect gate, stores real images", async () => {
    const ak = await akPromise;
    const { action } = await import("../routes/api.v1.manage.images.import");

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://cdn.example.com/pool.jpg") return png();
      if (u === "https://cdn.example.com/redirect-private") {
        return new Response(null, { status: 302, headers: { location: "https://192.168.1.10/steal" } });
      }
      if (u === "https://cdn.example.com/not-an-image") return new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      for (const url of ["http://cdn.example.com/x.jpg", "https://localhost/x.jpg", "https://10.0.0.8/x.jpg", "https://169.254.169.254/latest", "https://internal.corp/x.jpg"]) {
        const refused = (await action({ request: jsonReq("/v1/manage/images/import", ak, { url }) } as never)) as Response;
        expect(refused.status, url).toBe(422);
      }
      expect(fetchMock).not.toHaveBeenCalled(); // gated before any request

      // A redirect that hops to a private IP is refused at the hop.
      const hop = (await action({ request: jsonReq("/v1/manage/images/import", ak, { url: "https://cdn.example.com/redirect-private" }) } as never)) as Response;
      expect(hop.status).toBe(422);

      const notImage = (await action({ request: jsonReq("/v1/manage/images/import", ak, { url: "https://cdn.example.com/not-an-image" }) } as never)) as Response;
      expect(notImage.status).toBe(422);

      const ok = (await action({ request: jsonReq("/v1/manage/images/import", ak, { url: "https://cdn.example.com/pool.jpg" }) } as never)) as Response;
      expect(ok.status).toBe(201);
      const { data } = (await ok.json()) as { data: { url: string } };
      expect(data.url).toMatch(/^\/images\/manage\/p1\/.+\.png$/);
      expect(r2Puts).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("website_enabled on the property PATCH", () => {
  it("toggles and round-trips", async () => {
    const ak = await akPromise;
    const { action } = await import("../routes/api.v1.manage.property");
    const on = (await action({
      request: new Request("http://localhost/v1/manage/property", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${ak}`, "content-type": "application/json" },
        body: JSON.stringify({ website_enabled: true }),
      }),
    } as never)) as Response;
    expect(((await on.json()) as { data: { website_enabled: boolean } }).data.website_enabled).toBe(true);
    expect(JSON.parse(store.get("settings:p1")!).websiteEnabled).toBe(true);
  });
});
