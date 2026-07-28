// Renders the tree from `parseRichText` as React elements.
//
// There is no `dangerouslySetInnerHTML` here, and there must never be: the tree
// only has four inline shapes and three block shapes, so a hotel's copy cannot
// express anything but those. That makes "no injection" a property of the code's
// structure rather than of getting escaping right.

import type { Block, Inline } from "~/lib/rich-text";
import { parseRichText } from "~/lib/rich-text";

function inline(nodes: Inline[]): React.ReactNode {
  return nodes.map((n, i) => {
    switch (n.kind) {
      case "text":
        return n.text;
      case "bold":
        return (
          <strong key={i} className="font-semibold text-ink">
            {inline(n.children)}
          </strong>
        );
      case "italic":
        return <em key={i}>{inline(n.children)}</em>;
      case "link":
        // Always treated as leaving the site: the parser only ever produces
        // absolute http(s) hrefs, so there's no internal case to handle.
        return (
          <a
            key={i}
            href={n.href}
            target="_blank"
            rel="noreferrer noopener nofollow"
            className="font-semibold text-accent hover:underline"
          >
            {inline(n.children)}
          </a>
        );
    }
  });
}

function block(b: Block, i: number, cls: string): React.ReactNode {
  // Spacing between blocks lives on the block itself: a single paragraph — by
  // far the common case — must render as one <p> with the caller's own classes,
  // exactly the element it was before this component existed.
  const base = `${i > 0 ? "mt-3 " : ""}${cls}`;
  const items = (list: Inline[][]) =>
    list.map((item, n) => (
      <li key={n} className="mt-1 first:mt-0">
        {inline(item)}
      </li>
    ));

  switch (b.kind) {
    case "p":
      // `whitespace-pre-line` keeps single newlines as line breaks, which is how
      // this copy has always rendered — hotels lay things out with the return key.
      return (
        <p key={i} className={`whitespace-pre-line ${base}`}>
          {inline(b.children)}
        </p>
      );
    case "ul":
      return (
        <ul key={i} className={`list-disc pl-5 ${base}`}>
          {items(b.items)}
        </ul>
      );
    case "ol":
      return (
        <ol key={i} start={b.start} className={`list-decimal pl-5 ${base}`}>
          {items(b.items)}
        </ol>
      );
  }
}

/**
 * A hotel's formatted copy.
 *
 * `className` lands on every block so callers keep the type scale they already
 * had — this is a drop-in for a `<p className="…">{text}</p>`, not a new look.
 */
export function RichText({
  text,
  className = "",
}: {
  text: string | undefined;
  className?: string;
}) {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return <>{parseRichText(trimmed).map((b, i) => block(b, i, className))}</>;
}
