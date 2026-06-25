import { redirect } from "react-router";

import type { Route } from "./+types/select-property";
import { requireAdmin, setSessionProperty } from "~/lib/auth.server";

// Resource route: the header switcher posts here to change which property the
// admin is editing, then bounces back to where they were.
export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const form = await request.formData();
  const id = String(form.get("propertyId") || "");
  const back = String(form.get("redirectTo") || "/admin");
  const safeBack = back.startsWith("/admin") ? back : "/admin";
  if (!id) return redirect(safeBack);
  return redirect(safeBack, { headers: { "Set-Cookie": await setSessionProperty(request, id) } });
}

export async function loader() {
  return redirect("/admin");
}
