/** How the charges on top of the room day-prices are laid out in the Channex
 *  payload. */
export function channexCharges(input: {
  pricing: {
    charges: { label: string; amount: number; kind?: "fee" | "tax" }[];
    taxLines: { label: string; amount: number }[];
    taxIncluded: number;
  };
  extraLines: { name: string; optionName?: string; amount: number }[];
  lines: { total: number; occupancy: { adults: number; children: number } }[];
  nights: number;
}) {
  const { lines, nights } = input;
  // Everything charged on top of the room day-prices is sent so that
  // sum(days) + sum(excluded services) + sum(exclusive taxes) equals exactly what
  // the guest paid. Fees (cleaning, operator fees) and extras are Channex
  // services (excluded: true = not part of the day prices). Taxes — on-top VAT
  // and city tax — are room-level `taxes`, so the PMS books them as taxes rather
  // than as services. Inclusive-mode VAT is already inside the day prices, so it
  // is sent as an inclusive tax (informational, adds nothing to the total).
  const partySize = lines.reduce((s, l) => s + l.occupancy.adults + l.occupancy.children, 0);
  const service = (type: "Fee" | "Extra", name: string, amount: number) => ({
    type,
    name,
    price_mode: "Per stay",
    price_per_unit: amount.toFixed(2),
    total_price: amount.toFixed(2),
    persons: partySize,
    nights,
    excluded: true,
  });
  const services = [
    ...input.pricing.charges.filter((c) => c.kind !== "tax").map((c) => service("Fee", c.label, c.amount)),
    ...input.extraLines.map((x) =>
      service("Extra", x.optionName ? `${x.name} — ${x.optionName}` : x.name, x.amount),
    ),
  ].filter((s) => Number(s.total_price) > 0);

  const taxes: { name: string; type: "vat" | "city_tax"; is_inclusive: boolean; amount: number }[] = [
    ...input.pricing.charges
      .filter((c) => c.kind === "tax")
      .map((c) => ({ name: c.label, type: "city_tax" as const, is_inclusive: false, amount: c.amount })),
    ...input.pricing.taxLines.map((t) => ({ name: t.label, type: "vat" as const, is_inclusive: false, amount: t.amount })),
    ...(input.pricing.taxIncluded > 0
      ? [{ name: "VAT", type: "vat" as const, is_inclusive: true, amount: input.pricing.taxIncluded }]
      : []),
  ].filter((t) => t.amount > 0);

  // Taxes belong to a room, so a multi-room booking splits each one across the
  // rooms in proportion to their price; the last room takes the rounding
  // remainder so the parts still sum to the tax charged.
  const roomWeights = lines.map((l) => l.total);
  const weightSum = roomWeights.reduce((a, b) => a + b, 0);
  const roomTaxes = (roomIndex: number) =>
    taxes
      .map((t) => {
        const share = (i: number) =>
          lines.length === 1 || weightSum <= 0
            ? i === 0 ? t.amount : 0
            : Math.round(((t.amount * roomWeights[i]) / weightSum) * 100) / 100;
        const amount =
          roomIndex === lines.length - 1
            ? Math.round((t.amount - lines.slice(0, -1).reduce((sum, _l, i) => sum + share(i), 0)) * 100) / 100
            : share(roomIndex);
        return { name: t.name, type: t.type, is_inclusive: t.is_inclusive, total_price: amount.toFixed(2) };
      })
      .filter((t) => Number(t.total_price) > 0);

  return { services, roomTaxes };
}

