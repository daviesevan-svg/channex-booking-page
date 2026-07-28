// Simple formatting for the prose a hotel types: **bold**, *italic*, links and
// lists. Pure — no DOM, no HTML.
//
// This parses to a TREE, and the renderer turns that tree into React elements.
// It never produces markup, which is the whole point: hotels write copy that is
// served on their own domain, from pages that also take card details, so there
// is no version of "accept HTML and sanitise it" worth the risk. An unsupported
// construct here can only ever come out as plain text.
//
// Deliberately conservative, because thousands of lines of copy already exist
// and none of it was written with a formatter in mind. Text with no markers must
// come out exactly as it went in — so a lone asterisk stays a lone asterisk,
// "5 * 3 metres" is not italic, and `_` means nothing at all (too common in
// slugs, emails and filenames to claim).

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: Inline[] }
  | { kind: "italic"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "p"; children: Inline[] }
  | { kind: "ul"; items: Inline[][] }
  /** `start` keeps a hotel's own numbering: a list that begins "3." shows 3. */
  | { kind: "ol"; start: number; items: Inline[][] };

/**
 * The inline scanner.
 *
 * - `[label](https://…)` — http(s) only, by construction. There is no branch
 *   that can produce a `javascript:` href.
 * - `**bold**` — tried before `*italic*` at the same position, so `**x**` is
 *   bold rather than an empty italic wrapping one.
 * - `*italic*` — must open on a non-space and close on a non-space, which is
 *   what keeps arithmetic and footnote stars out of it.
 */
const INLINE =
  /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*(?=\S)((?:[^*]|\*(?!\*))+?)\*\*|\*(?=\S)([^*\n]*[^\s*])\*/;

/** Belt and braces: every branch recurses on strictly shorter input, so this
 *  can't run away — but a cap means a pathological string can't cost much either. */
const MAX_DEPTH = 6;

function parseInline(src: string, depth = 0): Inline[] {
  if (!src) return [];
  if (depth >= MAX_DEPTH) return [{ kind: "text", text: src }];

  const out: Inline[] = [];
  let rest = src;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push({ kind: "text", text: rest });
      break;
    }
    if (m.index > 0) out.push({ kind: "text", text: rest.slice(0, m.index) });
    if (m[1] !== undefined) {
      out.push({ kind: "link", href: m[2], children: parseInline(m[1], depth + 1) });
    } else if (m[3] !== undefined) {
      out.push({ kind: "bold", children: parseInline(m[3], depth + 1) });
    } else {
      out.push({ kind: "italic", children: parseInline(m[4], depth + 1) });
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const BULLET = /^[ \t]*[-•*][ \t]+(.*)$/;
const NUMBER = /^[ \t]*(\d{1,3})[.)][ \t]+(.*)$/;

/**
 * Split copy into blocks.
 *
 * Runs of list lines become one list; everything else gathers into paragraphs
 * that keep their single newlines, so a hotel who has never typed a marker gets
 * exactly the line breaks they already had.
 */
export function parseRichText(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];

  const flushPara = () => {
    const text = para.join("\n").trim();
    para = [];
    if (text) blocks.push({ kind: "p", children: parseInline(text) });
  };

  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBER.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      const start = numbered ? Number(numbered[1]) : 1;
      const items: Inline[][] = [];
      // Take every following line of the SAME kind — a bulleted run and a
      // numbered run next to each other are two lists, not one muddled one.
      while (i < lines.length) {
        const b = BULLET.exec(lines[i]);
        const n = NUMBER.exec(lines[i]);
        const match = ordered ? n : b;
        if (!match || Boolean(n) !== ordered) break;
        items.push(parseInline((ordered ? match[2] : match[1]).trim()));
        i++;
      }
      blocks.push(ordered ? { kind: "ol", start, items } : { kind: "ul", items });
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return blocks;
}

/** True when `src` contains nothing this parser would treat as formatting, so a
 *  caller can skip the tree entirely and render the string as it always was. */
export function isPlainText(src: string): boolean {
  const blocks = parseRichText(src);
  if (blocks.length !== 1 || blocks[0].kind !== "p") return false;
  const kids = blocks[0].children;
  return kids.length <= 1 && (kids.length === 0 || kids[0].kind === "text");
}
