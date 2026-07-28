// Translate a sentence that has to contain React nodes — links, usually.
//
// `tr.t()` returns a string, so a sentence with a link in the middle used to get
// built by concatenating English fragments in JSX. That can't be translated:
// word order differs by language, and in German the verb lands at the end. This
// keeps the whole sentence in one translatable template with `{placeholders}`
// the caller fills with nodes, so a translator can put them wherever the
// language needs them.

import { Fragment, type ReactNode } from "react";

import type { Translator } from "~/lib/i18n";

export function Trans({
  tr,
  k,
  parts,
  vars,
}: {
  tr: Translator;
  /** i18n key whose text contains `{name}` for each key of `parts`. */
  k: string;
  parts: Record<string, ReactNode>;
  /** Plain string/number substitutions, interpolated before the split. */
  vars?: Record<string, string | number>;
}) {
  // `interpolate` leaves a {token} alone when it isn't in `vars`, so the node
  // placeholders survive this call untouched.
  const text = tr.t(k, vars);
  const out: ReactNode[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;

  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    // Not one of ours — leave it in the text rather than swallowing it, so a
    // stray or misspelled token is visible instead of silently disappearing.
    if (!(name in parts)) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<Fragment key={`${name}-${i++}`}>{parts[name]}</Fragment>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));

  return <>{out}</>;
}
