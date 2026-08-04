// The font set the PDF renderers draw with, and the rule for picking between
// its two families.
//
// pdf-lib's standard fonts are WinAnsi-only, so both renderers embed Noto Sans
// (subsetted to Latin + Latin Extended + Greek + Cyrillic) to get guest names
// like "Νίκος" or "Дмитрий" right. No OFL font covers all of that AND Thai, so
// Thai arrives as a SECOND family, Noto Sans Thai, and `fontFor` swaps to it for
// any string containing Thai. Without the swap the glyphs aren't missing in an
// obvious way — pdf-lib doesn't throw, it silently draws .notdef boxes.
//
// The Thai family carries Latin too, so a mixed string ("ขอห้องชั้นสูง, flight
// TG910") renders wholly in one font rather than being split into runs — which
// would mean summing widths across runs in every wrap and right-align. The
// case that swap can't serve is Thai mixed with Greek/Cyrillic in ONE string;
// the Greek would fall back to .notdef.
import type { PDFDocument, PDFFont } from "pdf-lib";

import notoSansRegularB64 from "./noto-sans-regular";
import notoSansBoldB64 from "./noto-sans-bold";
import notoSansThaiRegularB64 from "./noto-sans-thai-regular";
import notoSansThaiBoldB64 from "./noto-sans-thai-bold";

/** Thai block. Guest text is the only place it can appear. */
const THAI = /[฀-๿]/;

/** Thai vowels and tone marks that hang off the preceding character. */
const THAI_COMBINING = /[ั-ฺ็-๎]/;

export const hasThai = (s: string): boolean => THAI.test(s);

/**
 * Greedy word-wrap for a proportional font, with a character-level fallback for
 * a single token too wide for the column.
 *
 * That fallback is not an edge case: Thai is written without spaces between
 * words, so a Thai gift message or special request arrives as ONE token and the
 * space-splitting pass alone would run it straight off the page (it does the
 * same to a long URL). Breaking by character is an approximation — placing
 * Thai line breaks properly needs dictionary-based word segmentation — but it
 * keeps the text inside the column, and it never separates a base character
 * from its marks.
 */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  const flush = () => {
    if (line) lines.push(line);
    line = "";
  };
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= maxWidth;

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    flush();
    if (fits(word)) {
      line = word;
      continue;
    }
    for (const ch of word) {
      if (line && !THAI_COMBINING.test(ch) && !fits(line + ch)) flush();
      line += ch;
    }
  }
  flush();
  return lines;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The base64-inlined TTFs, decoded once per isolate and reused across renders.
let fontBytes: Record<"regular" | "bold" | "thaiRegular" | "thaiBold", Uint8Array> | null = null;
function getFontBytes() {
  fontBytes ??= {
    regular: b64ToBytes(notoSansRegularB64),
    bold: b64ToBytes(notoSansBoldB64),
    thaiRegular: b64ToBytes(notoSansThaiRegularB64),
    thaiBold: b64ToBytes(notoSansThaiBoldB64),
  };
  return fontBytes;
}

export interface PdfFonts {
  regular: PDFFont;
  bold: PDFFont;
  /**
   * The font that can actually render `s`: the Thai counterpart of `requested`
   * when `s` contains Thai, otherwise `requested` untouched.
   *
   * Pass it every string you draw — and use its result for the width maths too
   * (wrapping, right-alignment), or the measured width won't match the glyphs
   * that end up on the page.
   */
  fontFor: (s: string, requested?: PDFFont) => PDFFont;
}

/**
 * Embed the font set into `doc`.
 *
 * `sample` is every string this document might draw (the raw payload is fine —
 * it's one regex over a few kB). The Thai family is embedded only when that
 * sample contains Thai, so a PDF without Thai in it carries exactly the fonts
 * it carried before this existed.
 */
export async function embedPdfFonts(doc: PDFDocument, sample: string): Promise<PdfFonts> {
  const bytes = getFontBytes();
  // subset: true → only the glyphs actually used are embedded in the PDF, so
  // the download stays small despite the coverage in the source fonts.
  const regular = await doc.embedFont(bytes.regular, { subset: true });
  const bold = await doc.embedFont(bytes.bold, { subset: true });
  const thai = hasThai(sample)
    ? {
        regular: await doc.embedFont(bytes.thaiRegular, { subset: true }),
        bold: await doc.embedFont(bytes.thaiBold, { subset: true }),
      }
    : null;

  const fontFor = (s: string, requested: PDFFont = regular): PDFFont => {
    if (!thai || !hasThai(s)) return requested;
    return requested === bold ? thai.bold : thai.regular;
  };

  return { regular, bold, fontFor };
}
