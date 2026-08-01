// The style a website page renders with, delivered to the section components.
//
// Context rather than props: every section and half their children need the slot
// table, and threading it through would mean touching the signature of anything
// that ever grows a class name. The provider sits in the guest layout, so the
// legacy booking page (no website, no stored style) gets `classic` from the
// default with nothing to configure.

import { createContext, useContext } from "react";

import type { SectionType } from "~/lib/sections";
import {
  DEFAULT_SITE_STYLE,
  siteStyle,
  type SiteStyleDef,
  type StyleSlots,
} from "~/lib/site-style";

const Ctx = createContext<SiteStyleDef>(siteStyle(DEFAULT_SITE_STYLE));

export function SiteStyleProvider({
  id,
  children,
}: {
  id: string | undefined;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={siteStyle(id)}>{children}</Ctx.Provider>;
}

export function useSiteStyle(): SiteStyleDef {
  return useContext(Ctx);
}

/** The slot table on its own — what almost every caller actually wants. */
export function useSlots(): StyleSlots {
  return useContext(Ctx).slots;
}

/**
 * The container a bleeding section has to put back for itself.
 *
 * A section can be declared full-width and then find it can't use that layout —
 * a rich-text block with no picture, or with three. Its band has already
 * withheld the gutters, so without this the prose would run to the viewport
 * edge. Empty whenever the section isn't bleeding, so it costs nothing.
 */
export function useBleedFallback(type: SectionType): string {
  const { band } = useSiteStyle();
  return band?.bleed?.includes(type) ? band.inner : "";
}

/**
 * The band behind one section.
 *
 * A style with no bands renders NO element — not a `<div>` with no classes. The
 * difference matters: it's what lets the classic markup stay byte-for-byte what
 * it was, so the refactor that introduced styles could be proven to change
 * nothing.
 *
 * `index` is the section's position, and the outer classes cycle through the
 * band list, so "alternate the background" is data rather than a special case in
 * the renderer.
 */
export function Band({
  index,
  type,
  children,
}: {
  index: number;
  type: SectionType;
  children: React.ReactNode;
}) {
  const { band } = useSiteStyle();
  if (!band) return <>{children}</>;
  const outer = band.outer[index % band.outer.length];
  // A bleeding section gets the band's background but not its container, so it
  // runs the full width. It supplies its own gutters for anything that still
  // needs to line up with the rest of the page.
  if (band.bleed?.includes(type)) return <div className={outer}>{children}</div>;
  return (
    <div className={outer}>
      <div className={band.inner}>{children}</div>
    </div>
  );
}
