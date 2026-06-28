import type { Route } from "./+types/api.changes";
import { applyChanges, checkApiKey } from "~/lib/ari.server";
import { isChannexConnected } from "~/lib/overrides.server";

// POST /api/changes — Channex pushes availability/rate/restriction changes.
export async function action({ request }: Route.ActionArgs) {
  const unauthorized = checkApiKey(request);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 });
  }

  // Only accept changes for properties that have selected Channex. Reject the
  // whole batch if any targeted property hasn't — we don't partially apply.
  const notifications = (body as { data?: unknown })?.data;
  const hotelCodes = new Set(
    (Array.isArray(notifications) ? notifications : [])
      .map((n) => String((n as { attributes?: { hotel_code?: unknown } })?.attributes?.hotel_code ?? ""))
      .filter(Boolean),
  );
  for (const code of hotelCodes) {
    if (!(await isChannexConnected(code))) {
      return Response.json(
        { success: false, error: `Property ${code} is not connected to Channex.` },
        { status: 403 },
      );
    }
  }

  try {
    const counts = await applyChanges(body);
    return Response.json({ success: true, ...counts });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : "Failed to apply changes" },
      { status: 422 },
    );
  }
}

// A GET here isn't part of the contract; respond clearly rather than 404.
export async function loader() {
  return Response.json({ success: false, error: "POST changes here" }, { status: 405 });
}
