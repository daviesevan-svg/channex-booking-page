import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import EN from "./admin-locales/en";

// Admin pages read their labels through `t("key")`. AdminT takes a plain
// string, so a key that no dictionary defines is not a type error — it falls
// back to the key itself and renders as lowercase English in every language.
// That is how the Tracking page shipped a "save" button on an otherwise German
// admin (2026-09-11). This walks the admin files and checks every literal key
// against the English dictionary, which every other language falls back to.

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

// Only files that use the admin translator: guest components call `tr.t(…)`
// against the guest dictionaries, and the lookbehind below keeps a stray
// `tr.t("…")` in a mixed file out of this check too.
const ADMIN_TRANSLATOR = /\b(useAdminT|adminT)\b/;
const LITERAL_KEY = /(?<![\w.])t\("([A-Za-z0-9_]+)"/g;

const adminFiles = [...walk("app/routes/admin"), ...walk("app/components")].filter(
  (f) => f.endsWith(".tsx") && ADMIN_TRANSLATOR.test(readFileSync(f, "utf8")),
);

describe("admin t() keys", () => {
  it("scans a meaningful number of admin files", () => {
    expect(adminFiles.length).toBeGreaterThan(20);
  });

  it("every literal key exists in the English dictionary", () => {
    const missing: string[] = [];
    for (const file of adminFiles) {
      const src = readFileSync(file, "utf8");
      for (const match of src.matchAll(LITERAL_KEY)) {
        const key = match[1];
        if (!(key in EN)) missing.push(`${file}: t("${key}")`);
      }
    }
    expect(missing).toEqual([]);
  });
});
