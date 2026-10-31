/**
 * lib/email/catalog.test.ts
 *
 * Every email-sending path in the repo is accounted for:
 *   - every template name a real caller passes to sendEmail (grepped from the
 *     source, not hand-listed) has a preview case, or sits on EXEMPT with a reason;
 *   - every registered template has a preview case (or is EXEMPT);
 *   - every security-alert builder is previewed;
 *   - docs/plans/EMAIL-CATALOG-2026-10-31.md names every template and every
 *     sending file, so a new send cannot land without a catalog row.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/email/catalog.test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { previewCases } from "@/lib/email/preview";
import { EMAIL_TEMPLATES } from "@/lib/email/templates";
import * as alerts from "@/lib/email/security-alerts";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

/** Template names that may lack a preview case, with the reason. Empty: everything is previewed. */
const EXEMPT: Record<string, string> = {};

const CATALOG = "docs/plans/EMAIL-CATALOG-2026-10-31.md";
/** Files that mention sendEmail without being a production send path. */
const NOT_SENDERS = new Set(["lib/email/send.ts", "lib/email/preview.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

// sendEmail("name", …) plus purge.ts's injected `email("name", …)` (EmailFn seam).
const SEND_RE = /\b(?:sendEmail|email)\(\s*"([a-z-]+)"/g;

const sites: { file: string; name: string }[] = [];
for (const root of ["app", "lib", "jobs"]) {
  for (const file of walk(root)) {
    if (NOT_SENDERS.has(file)) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(SEND_RE)) {
      // Ignore mentions inside comments (" * … sendEmail("x", …)").
      const line = src.slice(src.lastIndexOf("\n", m.index) + 1, src.indexOf("\n", m.index));
      if (/^\s*(\*|\/\/)/.test(line)) continue;
      sites.push({ file, name: m[1] });
    }
  }
}

const previewed = new Set(previewCases().map((c) => c.template));
const catalog = readFileSync(CATALOG, "utf8");

console.log("1. grepped send sites");
check("found the known send sites (sanity: ≥ 20)", sites.length >= 20, sites.length);
for (const name of new Set(sites.map((s) => s.name))) {
  check(`"${name}" is a registered template`, name in EMAIL_TEMPLATES);
  check(`"${name}" has a preview case or an explicit exemption`, previewed.has(name as never) || name in EXEMPT);
}

console.log("2. registry");
for (const name of Object.keys(EMAIL_TEMPLATES)) {
  check(`registered "${name}" is previewed or exempt`, previewed.has(name as never) || name in EXEMPT);
  check(`registered "${name}" is in the catalog`, catalog.includes(`\`${name}\``));
}

console.log("3. security-alert builders");
const previewSrc = readFileSync("lib/email/preview.ts", "utf8");
for (const fn of Object.keys(alerts).filter((k) => k.endsWith("Alert"))) {
  check(`${fn} is previewed`, previewSrc.includes(`alerts.${fn}(`));
  check(`${fn} is in the catalog`, catalog.includes(fn));
}

console.log("4. catalog names every sending file");
for (const file of new Set(sites.map((s) => s.file))) {
  check(`${file} is in the catalog`, catalog.includes(file));
}

console.log(failures === 0 ? "\nAll email catalog checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
