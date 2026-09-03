import { describe, expect, it, vi } from "vitest";

// The hotel's own legal links, saved from the three slots on the General page.
// Rows are read POSITIONALLY, so what's pinned here is alignment: slot 2's mode
// must land on slot 2's link even when slot 1 is empty. That's why the mode is a
// select and not a tick-box — an unticked box submits nothing and would shift
// every later row's mode onto the wrong link.

const store = new Map<string, string>();
const kv = {
  get: async (k: string) => store.get(k) ?? null,
  put: async (k: string, v: string) => void store.set(k, v),
  delete: async (k: string) => void store.delete(k),
};

vi.mock("cloudflare:workers", () => ({ env: { CONFIG_KV: kv }, waitUntil: () => {} }));

const { saveSettings } = await import("./overrides.server");

/** The three slots exactly as the form posts them — including the empty ones. */
function form(rows: [string, string, string][]) {
  const f = new FormData();
  f.set("currency", "GBP");
  for (const [label, url, mode] of rows) {
    f.append("legalLabel", label);
    f.append("legalUrl", url);
    f.append("legalMode", mode);
  }
  return f;
}

describe("custom legal links", () => {
  it("keeps each row's mode with its own link when earlier slots are empty", async () => {
    store.set("settings:p1", JSON.stringify({ currency: "GBP" }));
    const s = await saveSettings("p1", form([
      ["", "", "footer"],
      ["House rules", "https://hotel.example/rules", "accept"],
      ["Impressum", "https://hotel.example/impressum", "footer"],
    ]));
    expect(s.legalLinks).toEqual([
      { label: "House rules", url: "https://hotel.example/rules", accept: true },
      { label: "Impressum", url: "https://hotel.example/impressum" },
    ]);
  });

  it("drops a row with no label, and a label with no usable URL still counts", async () => {
    store.set("settings:p1", JSON.stringify({ currency: "GBP" }));
    const s = await saveSettings("p1", form([
      ["", "https://hotel.example/orphan", "footer"],
      ["House rules", "not a url", "accept"],
      ["", "", "footer"],
    ]));
    expect(s.legalLinks).toEqual([{ label: "House rules", url: undefined, accept: true }]);
  });

  it("clears the setting when every slot is blank", async () => {
    store.set("settings:p1", JSON.stringify({ currency: "GBP", legalLinks: [{ label: "Old" }] }));
    const s = await saveSettings("p1", form([["", "", "footer"], ["", "", "footer"], ["", "", "footer"]]));
    expect(s.legalLinks).toBeUndefined();
  });
});
