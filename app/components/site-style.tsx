// The style a website page renders with, delivered to the section components.
//
// Context rather than props: every section and half their children need the slot
// table, and threading it through would mean touching the signature of anything
// that ever grows a class name. The provider sits in the guest layout, so the
// legacy booking page (no website, no stored style) gets `classic` from the
// default with nothing to configure.

import { createContext, useContext } from "react";

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
export function Band({ index, children }: { index: number; children: React.ReactNode }) {
  const { band } = useSiteStyle();
  if (!band) return <>{children}</>;
  return (
    <div className={band.outer[index % band.outer.length]}>
      <div className={band.inner}>{children}</div>
    </div>
  );
}
