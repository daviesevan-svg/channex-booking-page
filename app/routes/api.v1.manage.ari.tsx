import type { Route } from "./+types/api.v1.manage.ari";
import { getInventory } from "~/lib/ari/read.server";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** One request reads three D1 tables fanned out per date — cap the window. */
const MAX_DAYS = 400;

// GET /v1/manage/ari?from&to[&room_id&rate_id] — read-only view of the ARI
// grid as the engine sells it: what a PMS reconciles against its own
// inventory. Prices are major units, decoded per the row's fraction_size
// (zero-decimal currencies come back whole). There are deliberately no write
// verbs: ARI is written only by Channex pushes and the admin grid
// (docs/management-api.md §1).
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const q = new URL(request.url).searchParams;
  const from = q.get("from") ?? "";
  const to = q.get("to") ?? "";
  if (!DATE.test(from) || !DATE.test(to)) return apiError(422, "validation_error", "`from` and `to` must be YYYY-MM-DD.");
  if (to < from) return apiError(422, "validation_error", "`to` must not be before `from`.");
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_DAYS) return apiError(422, "validation_error", `The window is capped at ${MAX_DAYS} days per request.`);
  const roomId = q.get("room_id");
  const rateId = q.get("rate_id");

  const inv = await getInventory(auth.pid, from, to);

  const availability = Object.entries(inv.availability)
    .map(([key, available]) => {
      const [room_id, date] = key.split("|");
      return { room_id, date, available };
    })
    .filter((r) => !roomId || r.room_id === roomId)
    .sort((a, b) => (a.date === b.date ? a.room_id.localeCompare(b.room_id) : a.date.localeCompare(b.date)));

  const cell = (key: string) => {
    const [room_id, rate_id, date] = key.split("|");
    return { room_id, rate_id, date };
  };
  const wanted = (r: { room_id: string; rate_id: string }) => (!roomId || r.room_id === roomId) && (!rateId || r.rate_id === rateId);

  const rates = Object.entries(inv.prices)
    .map(([key, price]) => ({ ...cell(key), price, prices_by_occupancy: inv.pricesByOcc[key] ?? {} }))
    .filter(wanted)
    .sort((a, b) => (a.date === b.date ? `${a.room_id}|${a.rate_id}`.localeCompare(`${b.room_id}|${b.rate_id}`) : a.date.localeCompare(b.date)));

  const restrictions = Object.entries(inv.restrictions)
    .map(([key, r]) => ({
      ...cell(key),
      stop_sell: r.stopSell,
      min_stay: r.minStay,
      closed_to_arrival: r.cta ?? false,
      closed_to_departure: r.ctd ?? false,
    }))
    .filter(wanted)
    .sort((a, b) => (a.date === b.date ? `${a.room_id}|${a.rate_id}`.localeCompare(`${b.room_id}|${b.rate_id}`) : a.date.localeCompare(b.date)));

  return Response.json({ data: { from, to, availability, rates, restrictions } });
}
