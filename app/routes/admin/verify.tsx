import { Link } from "react-router";

import type { Route } from "./+types/verify";
import { createAdminSession, isAllowedEmail, verifyMagicToken } from "~/lib/auth.server";

export async function loader({ request }: Route.LoaderArgs) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const email = await verifyMagicToken(token);
  if (!email || !isAllowedEmail(email)) {
    return { error: "This sign-in link is invalid or has expired." };
  }
  // Sets the session cookie and redirects to /admin.
  throw await createAdminSession(email, "/admin");
}

export default function Verify({ loaderData }: Route.ComponentProps) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 text-center">
      <h1 className="mb-2 font-serif text-[24px] font-semibold">Sign-in failed</h1>
      <p className="mb-5 text-[15px] text-secondary">{loaderData?.error}</p>
      <Link
        to="/admin/login"
        className="mx-auto rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep"
      >
        Back to sign in
      </Link>
    </main>
  );
}
