#!/usr/bin/env node
/**
 * Fails if guest-facing code formats a price or a date without the guest's
 * language.
 *
 * Prices and dates on guest pages go through the translator: `tr.money`,
 * `tr.moneyParts`, `tr.date`, `tr.dateRange` (app/lib/i18n.ts). Those apply the
 * language's own separators, symbol position and date order from the baked
 * table in app/lib/locale-format.ts — "54,00 €" and "po 14. – st 16. 12." for a
 * Slovak guest. A bare `formatMoney(x, cur)` or a hand-written date-fns pattern
 * still works and still renders, just in English shape, so nothing else would
 * ever report it. Every call site was converted in one pass; this keeps it so.
 *
 * Scope: guest routes and components (admin excluded) plus the guest-side libs
 * listed in EXTRA. English-only outputs (the booking and voucher PDFs, the
 * voucher emails, notes sent to the hotel or Channex) live in other files and
 * deliberately stay English.
 *
 * A genuine exception (text sent to a third party in English, say) opts out with
 * a trailing `// guest-format-exempt: <reason>` on the same line.
 */
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const EXTRA = ["app/lib/use-date-range.ts", "app/lib/email-render.server.ts"];
// Admin-only components that happen to live outside the admin- prefix.
const ADMIN_ONLY = new Set(["app/components/blocked-ranges.tsx"]);

const RULES = [
  { re: /(?<![.\w])formatMoney(Parts)?\(/, why: "use tr.money / tr.moneyParts" },
  { re: /(?<![.\w])fmtDate\(/, why: "use tr.date" },
  // A date-fns pattern with day/month/weekday letters. "yyyy-MM-dd" is a data
  // key, not display text, so it's allowed.
  {
    test: (line) =>
      [...line.matchAll(/(?<![.\w])format\(.*?,\s*["'`]([^"'`]*)["'`]/g)].some(
        (m) => m[1] !== "yyyy-MM-dd" && /[dMEL]/.test(m[1]),
      ),
    why: "use tr.date / tr.dateRange",
  },
];
const EXEMPT = /\/\/\s*guest-format-exempt:/;

const tracked = execSync("git ls-files 'app/routes/**/*.tsx' 'app/components/*.tsx'", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !f.startsWith("app/routes/admin/") && !f.startsWith("app/components/admin-") && !ADMIN_ONLY.has(f))
  .concat(EXTRA)
  .filter((f) => existsSync(f));

const problems = [];
for (const f of tracked) {
  readFileSync(f, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (EXEMPT.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
      for (const { re, test, why } of RULES) if (re ? re.test(line) : test(line)) problems.push(`${f}:${i + 1}  ${why}\n    ${line.trim()}`);
    });
}

if (problems.length) {
  console.error(`✗ guest formatting: ${problems.length} price/date formatted without the guest's language\n`);
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`✓ guest formatting: prices and dates follow the guest's language in ${tracked.length} files`);
