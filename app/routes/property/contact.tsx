// Contact-form submission. A resource route: the home page's contact section
// posts here with a fetcher, so the form works without the landing page needing
// an action of its own.
//
// A public form that emails the hotel is a spam vector, so this is deliberately
// narrow: rate limited per IP, length capped, honeypot, and the subject line is
// built entirely from OUR text — guest input never reaches a mail header.

import { redirect } from "react-router";

import type { Route } from "./+types/contact";
import { sendContactEmail } from "~/lib/email.server";
import { getOverrides, getSettings } from "~/lib/overrides.server";
import { resolvePropertyId } from "~/lib/properties.server";
import { clientKey, rateLimit } from "~/lib/rate-limit.server";
import { langFromRequest } from "~/lib/content";
import { basePath } from "~/lib/base";

const MAX_NAME = 100;
const MAX_EMAIL = 200;
const MAX_MESSAGE = 2000;

/** Anything reaching this by GET is a stray link or a crawler — send it home
 *  rather than rendering an empty layout. */
export async function loader({ params }: Route.LoaderArgs) {
  const base = basePath(params.channelId);
  return redirect(`${base}`);
}

export async function action({ params, request }: Route.ActionArgs) {
  const pid = await resolvePropertyId(params.channelId);
  const form = await request.formData();

  // Honeypot: a real guest never sees this field, so anything in it is a bot.
  // Answer as though it worked — telling a bot it failed just invites a retry.
  if (String(form.get("website") ?? "").trim()) return { ok: true as const };

  const name = String(form.get("name") ?? "").trim().slice(0, MAX_NAME);
  const email = String(form.get("email") ?? "").trim().slice(0, MAX_EMAIL);
  const message = String(form.get("message") ?? "").trim().slice(0, MAX_MESSAGE);

  if (!name || !email || !message) return { error: "missing" as const };
  // Deliberately loose: the point is to catch a typo, not to adjudicate RFC 5322.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email)) return { error: "email" as const };

  if (!(await rateLimit(`contact:${pid}:${clientKey(request)}`, 5, 3600))) {
    return { error: "throttled" as const };
  }

  const [settings, overrides] = await Promise.all([
    getSettings(pid),
    getOverrides(pid, langFromRequest(request)),
  ]);
  const to = settings.hostNotifyEmail || settings.emailReplyTo || overrides.email;
  // No address to send to: say so rather than showing a thank-you for a message
  // that went nowhere.
  if (!to) return { error: "unavailable" as const };

  const { sent } = await sendContactEmail({
    pid,
    to,
    hotelName: overrides.hotelName || "Your hotel",
    guestName: name,
    guestEmail: email,
    message,
  });
  return sent ? { ok: true as const } : { error: "failed" as const };
}
