// Website footer — pure types and helpers (safe on the client).
//
// The footer is chrome on EVERY website page, not a home-page section, so it
// lives beside the page's section list rather than inside it.

/** Fixed allowlist, so only platforms we intend to render can appear and each
 *  one has a translated-free brand label. */
export const SOCIAL_PLATFORMS = [
  "instagram",
  "facebook",
  "tripadvisor",
  "x",
  "youtube",
  "linkedin",
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

/** Brand names aren't translated, so these are plain constants. */
export const SOCIAL_LABEL: Record<SocialPlatform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tripadvisor: "Tripadvisor",
  x: "X",
  youtube: "YouTube",
  linkedin: "LinkedIn",
};

/** Room to add a handful of the hotel's own links without the footer sprawling. */
export const MAX_FOOTER_LINKS = 6;

export interface FooterLink {
  /** Stable id — keys this link's per-language label. */
  id: string;
  url: string;
}

export interface SiteFooter {
  /** Show the address / phone / email block. Default on: it's the thing guests
   *  most often come to a footer looking for. */
  showContact?: boolean;
  /** platform → profile URL. Absent or empty = not shown. */
  social?: Partial<Record<SocialPlatform, string>>;
  links?: FooterLink[];
}

/** http(s) only, else undefined — so a pasted `javascript:` or a typo can never
 *  become an anchor we render. */
export function httpUrl(input: string): string | undefined {
  const s = input.trim();
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function isSocialPlatform(v: string): v is SocialPlatform {
  return (SOCIAL_PLATFORMS as readonly string[]).includes(v);
}

/** Drop links with no usable URL and cap the list — a hand-edited KV value
 *  can't put an unbounded or unsafe set in front of guests. */
export function normalizeFooter(input: SiteFooter | undefined): SiteFooter {
  const social: Partial<Record<SocialPlatform, string>> = {};
  for (const [k, v] of Object.entries(input?.social ?? {})) {
    if (!isSocialPlatform(k)) continue;
    const url = httpUrl(String(v ?? ""));
    if (url) social[k] = url;
  }
  const seen = new Set<string>();
  const links: FooterLink[] = [];
  for (const l of input?.links ?? []) {
    if (!l?.id || seen.has(l.id)) continue;
    const url = httpUrl(String(l.url ?? ""));
    if (!url) continue;
    seen.add(l.id);
    links.push({ id: l.id, url });
    if (links.length >= MAX_FOOTER_LINKS) break;
  }
  return { showContact: input?.showContact ?? true, social, links };
}

/** The footer with its text resolved for one language. */
export interface ResolvedFooter {
  showContact: boolean;
  blurb?: string;
  social: { platform: SocialPlatform; label: string; url: string }[];
  /** Only links that have both a label and a URL — an unlabelled link would
   *  render as an empty anchor nobody can see or click. */
  links: { label: string; url: string }[];
}

export const FOOTER_COPY_ID = "footer";
export const footerBlurbKey = () => `${FOOTER_COPY_ID}.blurb`;
export const footerLinkKey = (id: string) => `${FOOTER_COPY_ID}.link_${id}`;
