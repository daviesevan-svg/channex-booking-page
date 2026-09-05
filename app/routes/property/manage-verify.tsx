import { redirect } from "react-router";

import type { Route } from "./+types/manage-verify";
import { createGuestSession, verifyGuestMagicToken } from "~/lib/guest-auth.server";
import { basePath } from "~/lib/base";
import { resolveRequestProperty } from "~/lib/property-scope.server";

/**
 * The guest portal magic link lands here.
 *
 * A valid token proves the mailbox, which is what a reference could not: the
 * session it creates has no `only`, so it may list everything for that email
 * — still at this property alone.
 *
 * The property is checked twice on purpose. The token carries the pid it was
 * minted for, and the URL says which property is being opened; on the shared
 * host a link mailed for hotel A would otherwise open hotel B's portal simply
 * by editing the path. A mismatch is not an error worth explaining, so it
 * lands back on the login form like any other bad link.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const base = basePath(params.channelId);
  const pid = await resolveRequestProperty(params.channelId, request);
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const claim = token ? await verifyGuestMagicToken(token) : null;
  if (!claim || claim.pid !== pid) throw redirect(`${base}/manage`);
  return createGuestSession({ email: claim.email, pid }, `${base}/manage`);
}

// Resource-style route: the loader always redirects, so there is nothing to
// render. React Router still wants a component export.
export default function ManageVerify() {
  return null;
}
