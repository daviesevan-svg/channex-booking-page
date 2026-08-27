import type { Route } from "./+types/api.v1.manage.site.footer";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { DEFAULT_LANG } from "~/lib/content";
import { footerBlurbKey, footerLinkKey } from "~/lib/footer";
import { validateFooterPut, type Errors } from "~/lib/manage-site-validate";
import { getFooterRaw, saveFooter } from "~/lib/site.server";

const validationError = (errors: Errors) =>
  Response.json({ error: { type: "validation_error", message: "The payload has invalid fields.", fields: errors } }, { status: 422 });

const serialize = (footer: Awaited<ReturnType<typeof getFooterRaw>>["footer"], text: Record<string, string>, lang: string) => ({
  lang,
  show_contact: footer.showContact !== false,
  social: footer.social ?? {},
  links: (footer.links ?? []).map((l) => ({ id: l.id, url: l.url, label: text[footerLinkKey(l.id)] ?? null })),
  blurb: text[footerBlurbKey()] ?? null,
});

// GET /v1/manage/site/footer?lang= — structure + that language's labels/blurb.
// PUT — structure + ONE language's text together, sparse over what's stored:
//     omitted fields keep their value; `links` REPLACES the link list when
//     present (labels ride each link, for the requested language; other
//     languages keep their labels for retained link ids and lose them for
//     removed links — a dead link's label in any language is an orphan).
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const lang = (new URL(request.url).searchParams.get("lang") || DEFAULT_LANG).toLowerCase();
  if (!/^[a-z]{2}$/.test(lang)) return apiError(422, "validation_error", "`lang` must be a two-letter language code.");
  const { footer, text } = await getFooterRaw(auth.pid, lang);
  return Response.json({ data: serialize(footer, text, lang) });
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "PUT") return apiError(405, "method_not_allowed", "Use PUT.");
  const lang = (new URL(request.url).searchParams.get("lang") || DEFAULT_LANG).toLowerCase();
  if (!/^[a-z]{2}$/.test(lang)) return apiError(422, "validation_error", "`lang` must be a two-letter language code.");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const { footer: current, text: currentText } = await getFooterRaw(auth.pid, lang);
  const parsed = validateFooterPut(body, current);
  if (!parsed.ok) return validationError(parsed.errors);
  const { footer, blurb, labels } = parsed.value;

  // Build this language's text map: keep what's stored, apply the patch.
  const text: Record<string, string> = { ...currentText };
  if (blurb !== undefined) {
    if (blurb === null) delete text[footerBlurbKey()];
    else text[footerBlurbKey()] = blurb;
  }
  for (const [linkId, label] of Object.entries(labels)) {
    if (label === null) delete text[footerLinkKey(linkId)];
    else text[footerLinkKey(linkId)] = label;
  }
  await saveFooter(auth.pid, lang, footer, text);

  const after = await getFooterRaw(auth.pid, lang);
  return Response.json({ data: serialize(after.footer, after.text, lang) });
}
