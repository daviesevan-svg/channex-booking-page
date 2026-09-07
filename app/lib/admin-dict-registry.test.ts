import { describe, expect, it } from "vitest";
import { registerAdminDict } from "./admin-dict-registry";
import { adminT } from "./admin-i18n";
import EN from "./admin-locales/en";

describe("admin labels registered by the root", () => {
  it("shares loader labels with admin routes and keeps the English fallback", () => {
    const key = Object.keys(EN)[0] as keyof typeof EN;
    registerAdminDict("de", { translated: "Hallo {name}" });
    expect(adminT("de")("translated", { name: "Ada" })).toBe("Hallo Ada");
    expect(adminT("de")(key)).toBe(EN[key]);
    expect(adminT("en")(key)).toBe(EN[key]);
  });

  it("picks up revalidated language data without null guest data clearing it", () => {
    registerAdminDict("de", { changed: "Before" });
    registerAdminDict("de", { changed: "After" });
    registerAdminDict("de", null);
    expect(adminT("de")("changed")).toBe("After");
    expect(adminT("de")("unknown_key")).toBe("unknown_key");
  });
});
