import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Inspect React Router's production dependency graph: a source-level import
// check cannot tell whether loader-only code was actually stripped by Vite.
const assets = resolve("build/client/assets");
const manifests = readdirSync(assets).filter((name) => /^manifest-.*\.js$/.test(name));
if (manifests.length !== 1) throw new Error(`Expected one router manifest, found ${manifests.length}. Run a fresh build first.`);
const source = readFileSync(resolve(assets, manifests[0]), "utf8");
const prefix = "window.__reactRouterManifest=";
if (!source.startsWith(prefix)) throw new Error("Unrecognised router manifest format");
const manifest = JSON.parse(source.slice(prefix.length).trim().replace(/;$/, ""));
const guestRoutes = Object.values(manifest.routes).filter((route) =>
  route.id === "root" || route.id.startsWith("routes/property/"),
);
if (guestRoutes.length < 2) throw new Error("Guest routes missing from router manifest");
const leaks = guestRoutes.flatMap((route) =>
  [route.module, ...(route.imports ?? [])]
    .filter((path) => /\/admin-i18n-[^/]+\.js$/.test(path))
    .map((path) => `${route.id}: ${path}`),
);
if (leaks.length) throw new Error(`Guest routes preload admin translations:\n${leaks.join("\n")}`);
console.log(`Guest bundle check passed: ${guestRoutes.length} routes do not preload the admin dictionary.`);
