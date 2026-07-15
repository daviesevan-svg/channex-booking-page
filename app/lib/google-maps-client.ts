// Client-side Google Maps JS helpers (admin geocoding). Uses Google's official
// inline bootstrap loader — it defines `google.maps.importLibrary` SYNCHRONOUSLY
// (queuing calls until the API is fetched), which is the only reliable way to
// know when constructors are ready; a hand-rolled <script> + onload does NOT
// work with the modern loader (see the collections map, which uses the same
// pattern). Loads at most once per page.

function bootstrapGoogleMaps(params: Record<string, string>) {
  ((g: any) => {
    let h: any, a: any, k: any;
    const p = "The Google Maps JavaScript API",
      c = "google",
      l = "importLibrary",
      q = "__ib__",
      m = document,
      b: any = (window as any)[c] || ((window as any)[c] = {});
    const d = b.maps || (b.maps = {}),
      r = new Set<string>(),
      e = new URLSearchParams(),
      u = () =>
        h ||
        (h = new Promise<void>((f, n) => {
          a = m.createElement("script");
          e.set("libraries", [...r] + "");
          for (k in g) e.set(k.replace(/[A-Z]/g, (t: string) => "_" + t[0].toLowerCase()), g[k]);
          e.set("callback", c + ".maps." + q);
          a.src = `https://maps.${c}apis.com/maps/api/js?` + e;
          d[q] = f;
          a.onerror = () => (h = n(new Error(p + " could not load.")));
          a.nonce = (m.querySelector("script[nonce]") as HTMLScriptElement | null)?.nonce || "";
          m.head.append(a);
        }));
    d[l]
      ? console.warn(p + " only loads once. Ignoring:", g)
      : (d[l] = (f: string, ...n: any[]) => r.add(f) && u().then(() => d[l](f, ...n)));
  })(params);
}

function ensureMaps(key: string) {
  const g = () => (window as any).google;
  if (!g()?.maps?.importLibrary) bootstrapGoogleMaps({ key, v: "weekly" });
  return g();
}

/** Geocode a free-form address to coordinates (browser only). Returns null when
 *  Google finds no match. Throws on load/auth failures — the caller shows a
 *  friendly message. Requires the Geocoding API to be enabled on the key's
 *  Google Cloud project (same key as the Maps JS API). */
export async function geocodeAddress(
  key: string,
  address: string,
): Promise<{ lat: number; lng: number; formatted: string } | null> {
  const g = ensureMaps(key);
  // A bad/unauthorized key makes the loader hang forever (the script loads over
  // HTTP fine, auth fails internally, and the ready callback never fires — so
  // neither onerror nor the importLibrary promise settles). Time out so the
  // caller can show an error instead of an eternal spinner.
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Google Maps did not respond — check the key.")), 10000),
  );
  const run = (async () => {
    const { Geocoder } = (await g.maps.importLibrary("geocoding")) as any;
    return new Geocoder().geocode({ address });
  })();
  const res = await Promise.race([run, timeout]);
  const first = res?.results?.[0];
  if (!first?.geometry?.location) return null;
  return {
    lat: first.geometry.location.lat(),
    lng: first.geometry.location.lng(),
    formatted: String(first.formatted_address ?? ""),
  };
}
