import { describe, expect, it } from "vitest";
import { VIVA_DESCRIPTION_MAX, vivaDescription } from "./viva-description";

const SAFE = /^[A-Za-z0-9 ]+$/;

describe("vivaDescription", () => {
  it("folds accents and drops punctuation and symbols", () => {
    expect(vivaDescription("Pensão São João — Quarto Duplo · 2 noites. €120,50")).toBe(
      "Pensao Sao Joao Quarto Duplo 2 noites 120 50",
    );
    expect(vivaDescription("Straße")).toBe("Strasse");
  });

  it("keeps the old long checkout description under the MB WAY limit", () => {
    const old =
      "Hotel Casa da Moira — Quarto Duplo Superior · Pequeno-almoço · 12 Dec 2026 – 15 Dec 2026 · 3 nights · 2 adults. Deposit now, €340.00 balance due at the property.";
    const out = vivaDescription(old);
    expect(out.length).toBeLessThan(70);
    expect(out.length).toBeLessThanOrEqual(VIVA_DESCRIPTION_MAX);
    expect(out).toMatch(SAFE);
    expect(out.endsWith(" ")).toBe(false);
    expect(old.replace(/[^A-Za-z0-9 ]/g, "")).not.toBe(out); // it really was cut
  });

  it("cuts a single over-long word hard", () => {
    expect(vivaDescription("x".repeat(200))).toBe("x".repeat(VIVA_DESCRIPTION_MAX));
  });

  it("falls back when nothing usable is left", () => {
    expect(vivaDescription("Отель Москва — ★★★")).toBe("Booking");
    expect(vivaDescription("", "Booking AB12CD34")).toBe("Booking AB12CD34");
  });
});
