import { beforeEach, describe, expect, it, vi } from "vitest";

// A Slovak guest's emails name the room, rate, taxes and fees in Slovak; the
// hotel's copy keeps the names the booking was stored under. Real templates and
// rendering; settings, the catalogue, KV and SparkPost are faked.

const sent: { to: string[]; subject: string; html: string }[] = [];
const settings = {
  hostNotifyEmail: "frontdesk@hotel.test",
  notifyHostOnBooking: true,
  taxes: [{ id: "v", name: "VAT", rate: 20, nameTranslations: { sk: "DPH" } }],
  fees: [],
  cityTax: { enabled: true, name: "City tax", amount: 2, basis: "person_night", taxable: false, childrenExempt: false, maxNights: 0 },
};

vi.mock("./config.server", () => ({
  getConfig: () => ({ sparkpostApiKey: "k", sparkpostApiUrl: "https://sparkpost.test", emailFrom: "Bookings <bookings@example.test>" }),
}));
vi.mock("./site.server", () => ({ getSiteStyle: async () => undefined }));
vi.mock("./partners.server", () => ({ brandOf: () => ({}), getPartner: async () => null, partnerForProperty: async () => null }));
vi.mock("./overrides.server", async () => {
  const { withEmailDefaults } = await import("./email-defaults.server");
  return {
    getSettings: async () => settings,
    getOverrides: async () => ({ hotelName: "U Maťka a Kubka", email: "owner@hotel.test" }),
    getEmailTemplate: async (_pid: string, id: string, lang?: string) => withEmailDefaults(id, {}, lang),
  };
});
vi.mock("./catalog.server", () => ({
  localizeBookingRooms: async (_pid: string, rooms: { roomTitle: string; rateTitle: string }[], lang: string) =>
    lang === "sk" ? rooms.map((r) => ({ ...r, roomTitle: "Záhradný apartmán", rateTitle: "S raňajkami" })) : rooms,
}));

vi.stubGlobal(
  "fetch",
  vi.fn(async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    sent.push({ to: b.recipients.map((r: { address: string }) => r.address), subject: b.content.subject, html: b.content.html });
    return new Response("{}", { status: 200 });
  }),
);

const { sendBookingEmails } = await import("./email.server");
const { sampleBooking } = await import("./email-render.server");
import type { BookingRecord } from "./bookings.server";

const booking = (lang: string): BookingRecord => ({
  ...sampleBooking("EUR"),
  lang,
  pricing: {
    charges: [
      { label: "Cleaning fee", amount: 15, kind: "fee" },
      { label: "City tax", amount: 8, kind: "tax" },
    ],
    taxLines: [{ label: "VAT (20%)", amount: 100 }],
    taxIncluded: 0,
  },
});

beforeEach(() => {
  sent.length = 0;
});

describe("guest emails in the guest's language", () => {
  it("Slovak guest: Slovak room, rate, tax and fee names; the hotel's copy keeps the stored ones", async () => {
    await sendBookingEmails("p1", booking("sk"), "https://example.test");
    const guest = sent.find((m) => m.to.includes("jamie@example.com"))!;
    const host = sent.find((m) => m.to.includes("frontdesk@hotel.test"))!;

    for (const sk of ["Záhradný apartmán", "S raňajkami", "Poplatok za upratovanie", "Daň za ubytovanie", "DPH (20%)"]) {
      expect(guest.html).toContain(sk);
    }
    expect(guest.html).not.toContain("Garden Suite");
    expect(guest.html).not.toContain("VAT (20%)");
    // Item 6: the name stays in the nominative after "v zariadení".
    expect(guest.subject).toContain("v zariadení U Maťka a Kubka");

    expect(host.html).toContain("Garden Suite");
    expect(host.html).toContain("VAT (20%)");
  });

  it("English guest: unchanged", async () => {
    await sendBookingEmails("p1", booking("en"), "https://example.test");
    const guest = sent.find((m) => m.to.includes("jamie@example.com"))!;
    expect(guest.html).toContain("Garden Suite");
    expect(guest.html).toContain("Cleaning fee");
  });
});
