import { sanitizeCustomCss } from "~/lib/custom-css";

/**
 * The property's own stylesheet, inside the guest wrapper. Rendered after the
 * theme's inline variables and FontFaces so its rules win on specificity ties,
 * which is the whole point of the sheet. Re-sanitised here as well as on save:
 * the stored value is under our control, but a render-time guard costs nothing
 * and makes the store-side rule a convenience rather than the only line.
 *
 * dangerouslySetInnerHTML because React would escape `<` to `&lt;` as a text
 * child, and a style element does not decode entities — see FontFaces.
 */
export function CustomCss({ css }: { css: string | null | undefined }) {
  if (!css) return null;
  const safe = sanitizeCustomCss(css);
  if (!safe) return null;
  return <style data-custom-css="" dangerouslySetInnerHTML={{ __html: safe }} />;
}
