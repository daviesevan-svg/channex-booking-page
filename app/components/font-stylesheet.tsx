// Load a Google Fonts stylesheet without blocking the first render.
//
// PageSpeed measured that request at 1.5 KiB but 750 ms — almost none of it
// transfer. It is DNS + TLS + a round trip to a third party, on the critical
// path, for a file whose only job is to say where the font files live. Making it
// non-blocking takes it off that path entirely.
//
// The mechanics: a stylesheet appended with `media="print"` does not block
// render, and flipping it to `media="all"` once loaded applies it. React can't
// emit an inline `onload=""` attribute (its onLoad is a real handler and would
// only attach at hydration, far too late), so the swap runs from a small inline
// script during head parse.
//
// The trade, accepted deliberately: text paints in the fallback face and swaps
// when the font lands, so the swap window is wider than with a blocking
// stylesheet. `display=swap` already meant a swap; this makes it later. Font
// swapping was the sole cause of the page's 0.039 CLS, so that number is the one
// to watch on the next run. The `preload` below is what keeps the window small —
// a `media="print"` sheet is deprioritised by browsers, and without it the fonts
// would arrive later than they do today.

/** Only Google Fonts URLs are ever interpolated into the inline script. The
 *  hrefs come from the FONT_PAIRS allowlist, but asserting the shape here means
 *  this stays safe even if a future caller passes something else. */
const ALLOWED = /^https:\/\/fonts\.googleapis\.com\/css2\?[\w=&;:@.+%,-]*$/;

export function FontStylesheet({ href }: { href: string | undefined }) {
  if (!href || !ALLOWED.test(href)) return null;
  const js =
    `(function(){var l=document.createElement("link");l.rel="stylesheet";` +
    `l.media="print";l.onload=function(){l.media="all"};l.href=${JSON.stringify(href)};` +
    `document.head.appendChild(l)})()`;
  return (
    <>
      {/* Fetched at stylesheet priority even though it won't block — a
          media="print" sheet on its own is treated as low priority. */}
      <link rel="preload" as="style" href={href} />
      <script dangerouslySetInnerHTML={{ __html: js }} />
      {/* Without JS the async swap never runs, so fall back to a plain (blocking)
          stylesheet rather than shipping a page with no typeface. */}
      <noscript>
        <link rel="stylesheet" href={href} />
      </noscript>
    </>
  );
}
