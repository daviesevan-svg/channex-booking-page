// Sets the admin's UI-language cookie (the header picker posts here) and
// returns to the page they were on. The cookie is per-browser, not per
// property — it's the admin's own preference.
import { redirect } from "react-router";

import type { Route } from "./+types/lang";
import { ADMIN_LANG_COOKIE, isAdminLang } from "~/lib/admin-i18n";

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const lang = String(form.get("lang") ?? "");
  const redirectTo = String(form.get("redirectTo") ?? "/admin");
  // Only same-site paths — never redirect off-host from form input.
  const to = redirectTo.startsWith("/") && !redirectTo.startsWith("//") ? redirectTo : "/admin";
  if (!isAdminLang(lang)) return redirect(to);
  return redirect(to, {
    headers: {
      "Set-Cookie": `${ADMIN_LANG_COOKIE}=${lang}; Path=/admin; Max-Age=31536000; SameSite=Lax`,
    },
  });
}

export function loader() {
  return redirect("/admin");
}
