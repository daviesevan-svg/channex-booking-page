#!/usr/bin/env node
/**
 * Fails if a guest-facing component hardcodes a font size or corner radius.
 *
 * Those values used to be typed straight into each route, which meant a template
 * could change the colours and the typeface but never the shape of the page.
 * They now live as tokens in app/app.css, so one override restyles every surface
 * at once. That only stays true if new code keeps using them — 642 call sites
 * were converted once, and without this check the debt simply re-accrues at
 * whatever rate we ship features.
 *
 * app/routes/admin/** is exempt on purpose: the admin UI is never templated, so
 * there is nothing for a token to buy there. `app/components/admin-*` is exempt
 * for the same reason — an admin panel that happens to live beside the guest
 * components is still admin UI, and the prefix is the existing convention
 * (admin-form.tsx).
 *
 * Genuine one-offs (an optical nudge that is not a design decision) can opt out
 * with a trailing `// design-token-exempt: <reason>` on the same line. Give a
 * real reason — "it's easier" is not one.
 */
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PATTERN = /\b(?:text|rounded)-\[[0-9.]+(?:px|rem)\]/g;
const EXEMPT = /\/\/\s*design-token-exempt:/;

// The one .ts file in scope: the website style table now holds the class strings
// the components used to inline, which makes it exactly where this debt would
// re-accrue unnoticed.
const EXTRA = ["app/lib/site-style.ts"];

// `git ls-files` lists what's tracked, which still includes a file deleted but
// not yet staged — reading it blind crashes the whole check with ENOENT, and
// since this runs inside `npm run typecheck` that looks like a type error.
const tracked = execSync("git ls-files 'app/**/*.tsx' 'app/*.tsx'", { encoding: "utf8" })
  .split("\n")
  .filter((f) => f.endsWith(".tsx"))
  .concat(EXTRA)
  .filter((f) => existsSync(f));

const isAdmin = (f) => f.startsWith("app/routes/admin/") || f.startsWith("app/components/admin-");

// Guest-only: the admin UI is never templated, so a hardcoded size costs
// nothing there.
const files = tracked.filter((f) => !isAdmin(f));

// ---- Second check: a token class that no longer exists -------------------
//
// Collapsing the scale from 25 steps to 13 retired nine class names. Tailwind
// generates a rule only for names it finds in the theme, so `text-title-3xl`
// left behind after a rename produces NO rule at all — the element silently
// inherits its parent's size and the page still renders. That is a worse
// failure than a hardcoded pixel value, because nothing anywhere reports it.
//
// Only the `title-`/`display-` families and the retired flat names are checked.
// A bare `text-<word>` is ambiguous — `text-white`, `text-center` and
// `text-secondary` are all legitimate and none of them are type tokens.
const THEME = readFileSync("app/app.css", "utf8");
const KNOWN_TYPE = new Set([...THEME.matchAll(/--text-([a-z0-9-]+):/g)].map((m) => m[1]));
const KNOWN_RADIUS = new Set([...THEME.matchAll(/--radius-([a-z0-9-]+):/g)].map((m) => m[1]));

// Retired in the 25 -> 13 collapse, with where each one went.
const RETIRED = {
  nano: "micro",
  "lead-lg": "lead",
  "title-xs": "title-sm",
  "title-xl": "title-md",
  "title-2xl": "title-lg",
  "title-3xl": "title-lg",
  "display-xs": "display-sm",
  "display-2xl": "display-lg",
  "display-3xl": "display-lg",
  "display-4xl": "display-lg",
  "display-5xl": "display-xl",
  "display-6xl": "display-xl",
};

const FAMILY = /\b(text-(?:title|display)-[a-z0-9-]+|text-(?:nano|lead-lg)|rounded-(?:mark|chip|control|field|card|panel|well)(?:-[a-z0-9]+)?)\b/g;

const unknown = [];
function checkNames(file, line, lineNo) {
  for (const m of line.match(FAMILY) ?? []) {
    const isRadius = m.startsWith("rounded-");
    const name = m.replace(/^(text|rounded)-/, "");
    const known = isRadius ? KNOWN_RADIUS.has(name) : KNOWN_TYPE.has(name);
    if (known) continue;
    unknown.push({
      file,
      line: lineNo,
      literal: m,
      hint: RETIRED[name] ? `retired — use ${isRadius ? "rounded" : "text"}-${RETIRED[name]}` : "no such token",
    });
  }
}

// Unlike the hardcoded-size rule, this one runs over admin too: a retired name
// renders just as silently wrong there, and admin was included in the rename.
for (const file of tracked) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => checkNames(file, line, i + 1));
}

if (unknown.length > 0) {
  console.error(`\n✗ ${unknown.length} reference${unknown.length === 1 ? "" : "s"} to a token that does not exist.`);
  console.error("  Tailwind emits no rule for these, so the element silently inherits its size.\n");
  for (const u of unknown) console.error(`  ${u.file}:${u.line}  ${u.literal}  (${u.hint})`);
  console.error();
  process.exit(1);
}

const hits = [];
for (const file of files) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (EXEMPT.test(line)) return;
      for (const m of line.match(PATTERN) ?? []) {
        hits.push({ file, line: i + 1, literal: m, text: line.trim().slice(0, 100) });
      }
    });
}

if (hits.length === 0) {
  console.log(`✓ design tokens: no hardcoded sizes in ${files.length} guest files`);
  process.exit(0);
}

console.error(`\n✗ ${hits.length} hardcoded size${hits.length === 1 ? "" : "s"} in guest code.\n`);
for (const h of hits) {
  console.error(`  ${h.file}:${h.line}  ${h.literal}`);
  console.error(`    ${h.text}`);
}
console.error(`
Use a token from the scale in app/app.css instead:

  font size   text-micro  text-label  text-caption  text-body  text-body-lg
              text-lead   text-title-*  text-display-*
  radius      rounded-mark  rounded-chip  rounded-control  rounded-card
              rounded-panel  rounded-well

If the value really is a one-off optical nudge rather than a design decision,
add a trailing comment on that line:

  // design-token-exempt: aligns the 7px diamond with the cap height
`);
process.exit(1);
