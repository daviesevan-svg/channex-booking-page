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
 * there is nothing for a token to buy there.
 *
 * Genuine one-offs (an optical nudge that is not a design decision) can opt out
 * with a trailing `// design-token-exempt: <reason>` on the same line. Give a
 * real reason — "it's easier" is not one.
 */
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PATTERN = /\b(?:text|rounded)-\[[0-9.]+(?:px|rem)\]/g;
const EXEMPT = /\/\/\s*design-token-exempt:/;

// `git ls-files` lists what's tracked, which still includes a file deleted but
// not yet staged — reading it blind crashes the whole check with ENOENT, and
// since this runs inside `npm run typecheck` that looks like a type error.
const files = execSync("git ls-files 'app/**/*.tsx' 'app/*.tsx'", { encoding: "utf8" })
  .split("\n")
  .filter((f) => f.endsWith(".tsx") && !f.startsWith("app/routes/admin/"))
  .filter((f) => existsSync(f));

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
