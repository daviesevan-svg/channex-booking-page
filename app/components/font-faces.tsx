// The typeface for a theme's font pair, declared inline.
//
// Replaces the old <FontStylesheet>, which loaded the pair from
// fonts.googleapis.com. The files are now mirrored into public/fonts/ (see
// scripts/fetch-fonts.mjs): no guest's browser is made to contact Google before
// the page renders, which is a hard requirement in Germany and something no
// consent banner could have fixed — that request went out during head parse.
//
// It is also faster than what it replaces. The old version existed purely to
// work around the third-party round trip: PageSpeed costed Google's stylesheet
// at 1.5 KiB but 750 ms, so it was loaded with the media="print" trick to keep
// it off the critical path, which in turn widened the swap window and was the
// sole cause of the page's 0.039 CLS. Inline @font-face has no round trip at
// all — the browser starts fetching the woff2 during head parse — so the trick,
// its inline script and its <noscript> fallback are all gone.
//
// ~9 kB of rules per pair, under 1 kB gzipped: the unicode-ranges repeat, which
// is exactly what compresses well. Cheaper than the request it removes.
import { FONT_FACE_CSS } from "~/lib/font-faces";
import { DEFAULT_FONT_PAIR_ID } from "~/lib/content";

function Faces({ id }: { id: string }) {
  const css = FONT_FACE_CSS[id];
  // An id with no generated faces means someone added a pair and didn't re-run
  // the script. Rendering nothing leaves the page in a system font rather than
  // breaking it; the test in font-faces.test.ts is what stops it shipping.
  if (!css) return null;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

/** The default pair, emitted by the root layout on every page. */
export function DefaultFontFaces() {
  return <Faces id={DEFAULT_FONT_PAIR_ID} />;
}

/** A property's chosen pair. Renders nothing for the default one — the root
 *  layout has already emitted it, and declaring the same faces twice is only
 *  bytes. */
export function FontFaces({ pair }: { pair: string | undefined }) {
  if (!pair || pair === DEFAULT_FONT_PAIR_ID) return null;
  return <Faces id={pair} />;
}
