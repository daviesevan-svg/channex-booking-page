// The website footer's upper block. The existing bottom bar (© … · Powered by
// Channex) is left exactly as it was and stays below this — legal and
// attribution text isn't something a hotel should be able to configure away.

import { Link } from "react-router";

import type { Translator } from "~/lib/i18n";
import type { ResolvedFooter } from "~/lib/footer";

export interface FooterContact {
  address?: string;
  phone?: string;
  email?: string;
}

export function SiteFooterBlock({
  footer,
  contact,
  hotelName,
  links,
  tr,
}: {
  footer: ResolvedFooter;
  contact: FooterContact;
  hotelName: string;
  /** Built-in destinations, worked out live by the layout (rooms only when
   *  there's a rooms section, vouchers only when something's on sale…). */
  links: { label: string; to: string; external?: boolean }[];
  tr: Translator;
}) {
  const hasContact =
    footer.showContact && Boolean(contact.address || contact.phone || contact.email);
  const hasLinks = links.length > 0 || footer.links.length > 0;
  const hasSocial = footer.social.length > 0;

  // Nothing to show — render nothing rather than an empty band above the bar.
  if (!hasContact && !hasLinks && !hasSocial && !footer.blurb) return null;

  return (
    <div className="border-t border-nav-border bg-surface-alt">
      <div className="mx-auto grid max-w-[1160px] grid-cols-1 gap-10 px-7 py-12 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <div className="mb-2.5 font-serif text-[19px] font-semibold">{hotelName}</div>
          {footer.blurb && (
            <p className="max-w-[320px] whitespace-pre-line text-[14px] leading-[1.6] text-muted">
              {footer.blurb}
            </p>
          )}
          {hasSocial && (
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
              {footer.social.map((s) => (
                <a
                  key={s.platform}
                  href={s.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-[13px] font-semibold text-secondary hover:text-accent"
                >
                  {s.label}
                </a>
              ))}
            </div>
          )}
        </div>

        {hasContact && (
          <div>
            <h2 className="mb-2.5 text-[12px] font-semibold uppercase tracking-wide text-muted-2">
              {tr.t("footerContact")}
            </h2>
            <div className="flex flex-col gap-1.5 text-[14px] leading-[1.6] text-muted">
              {contact.address && <span className="whitespace-pre-line">{contact.address}</span>}
              {contact.phone && (
                <a href={`tel:${contact.phone.replace(/\s+/g, "")}`} className="hover:text-accent">
                  {contact.phone}
                </a>
              )}
              {contact.email && (
                <a href={`mailto:${contact.email}`} className="break-all hover:text-accent">
                  {contact.email}
                </a>
              )}
            </div>
          </div>
        )}

        {hasLinks && (
          <div>
            <h2 className="mb-2.5 text-[12px] font-semibold uppercase tracking-wide text-muted-2">
              {tr.t("footerExplore")}
            </h2>
            <div className="flex flex-col gap-1.5 text-[14px]">
              {links.map((l) =>
                l.external ? (
                  <a
                    key={l.to}
                    href={l.to}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-muted hover:text-accent"
                  >
                    {l.label}
                  </a>
                ) : (
                  <Link key={l.to} to={l.to} className="text-muted hover:text-accent">
                    {l.label}
                  </Link>
                ),
              )}
              {footer.links.map((l) => (
                <a
                  key={l.url}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-muted hover:text-accent"
                >
                  {l.label}
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
