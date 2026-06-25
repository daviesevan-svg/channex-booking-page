import type { Route } from "./+types/api.changes";
import { applyChanges, checkApiKey } from "~/lib/ari.server";

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
