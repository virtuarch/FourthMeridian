/**
 * lib/email/catalog.test.ts
 *
 * Every email-sending path in the repo is accounted for:
 *   - every template name a caller passes to sendEmail (grepped from app/, lib/,
 *     jobs/ AND scripts/ — not hand-listed) has a preview case, or sits on
 *     EXEMPT with a reason;
 *   - a sendEmail whose template name is NOT a string literal must be on
 *     VARIABLE_NAME_SENDERS with the exact names it can send;
 *   - every channel-adapter (re-)delivery (`adapter.deliver(` — create.ts and
 *     the retry job) is a `notification` send and is catalogued;
 *   - every registered template has a preview case (or is EXEMPT);
 *   - every security-alert builder is previewed;
 *   - docs/plans/EMAIL-CATALOG-2026-10-31.md names every template, builder and
 *     sending file as WHOLE tokens, so a new send cannot land without a row.
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

/** sendEmail call sites whose template name is a variable, with every name they can send. */
const VARIABLE_NAME_SENDERS: Record<string, readonly string[]> = {
  // The preview tool sends exactly the preview cases (allowlisted recipient only).
  "scripts/email-preview.ts": [...new Set(previewCases().map((c) => c.template))],
};

const CATALOG = "docs/plans/EMAIL-CATALOG-2026-10-31.md";
/** The chokepoint itself and the preview logic (which only renders) are not send paths. */
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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `token` appears in `text` as a whole token (not inside a longer identifier/path). */
function hasToken(text: string, token: string): boolean {
  return new RegExp(`(?<![\\w./-])${escapeRe(token)}(?![\\w-])`).test(text);
}

/** Drop comment text so a mention in a doc comment never counts as a send. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// Literal template names: sendEmail("x", …), purge's injected email("x", …),
// a guarded send("x", …) inside lib/email/send-security-alert.ts.
// (`.sendEmail(` counts — e.g. a dynamic import — but `.email(` never does: zod.)
const LITERAL_RE = /(\bsendEmail|(?<![.\w])email|(?<![.\w])send)\(\s*"([^"]*)"\s*,/g;
// sendEmail with a NON-literal first argument.
const VARIABLE_RE = /\bsendEmail\(\s*(?!["\s])/g;
// Guarded security alerts.
const GUARDED_RE = /(?<![.\w])sendSecurityAlert\(/g;
// Channel-adapter delivery = the `notification` template (channels/email.ts).
const ADAPTER_RE = /\b(?:adapter|args\.adapter)\.deliver\(/g;

const sites: { file: string; name: string; via: string }[] = [];
const variableSites: string[] = [];
for (const root of ["app", "lib", "jobs", "scripts"]) {
  for (const file of walk(root)) {
    if (NOT_SENDERS.has(file)) continue;
    const code = stripComments(readFileSync(file, "utf8"));
    for (const m of code.matchAll(LITERAL_RE)) {
      // `send(` / `email(` count only where they are the email seams.
      if (m[1] === "send" && file !== "lib/email/send-security-alert.ts") continue;
      sites.push({ file, name: m[2], via: m[1] });
    }
    for (const _ of code.matchAll(VARIABLE_RE)) variableSites.push(file);
    for (const _ of code.matchAll(GUARDED_RE)) {
      if (file !== "lib/email/send-security-alert.ts") sites.push({ file, name: "security-alert", via: "sendSecurityAlert" });
    }
    for (const _ of code.matchAll(ADAPTER_RE)) sites.push({ file, name: "notification", via: "adapter.deliver" });
  }
}
for (const file of new Set(variableSites)) {
  for (const name of VARIABLE_NAME_SENDERS[file] ?? []) sites.push({ file, name, via: "variable" });
}

const previewed = new Set<string>(previewCases().map((c) => c.template));
const catalog = readFileSync(CATALOG, "utf8");

console.log("1. grepped send sites");
check("found the known send sites (sanity: ≥ 20)", sites.length >= 20, sites.length);
check("adapter re-delivery is covered (create.ts + the retry job)",
  ["lib/notifications/create.ts", "jobs/retry-notifications.ts"].every((f) => sites.some((s) => s.file === f && s.via === "adapter.deliver")));
check("the guarded export alert is covered", sites.some((s) => s.file === "app/api/user/export/route.ts" && s.via === "sendSecurityAlert"));
check("scripts/ senders are scanned", sites.some((s) => s.file.startsWith("scripts/")));
for (const file of new Set(variableSites)) {
  check(`${file}: a variable template name is declared in VARIABLE_NAME_SENDERS`, file in VARIABLE_NAME_SENDERS);
}
for (const name of new Set(sites.map((s) => s.name))) {
  check(`"${name}" is a registered template`, Object.prototype.hasOwnProperty.call(EMAIL_TEMPLATES, name));
  check(`"${name}" has a preview case or an explicit exemption`, previewed.has(name) || name in EXEMPT);
}

console.log("2. registry");
for (const name of Object.keys(EMAIL_TEMPLATES)) {
  check(`registered "${name}" is previewed or exempt`, previewed.has(name) || name in EXEMPT);
  check(`registered "${name}" is in the catalog (as \`${name}\`)`, catalog.includes(`\`${name}\``));
}

console.log("3. security-alert builders");
const previewSrc = readFileSync("lib/email/preview.ts", "utf8");
for (const fn of Object.keys(alerts).filter((k) => k.endsWith("Alert"))) {
  check(`${fn} is previewed`, new RegExp(`\\balerts\\.${fn}\\(`).test(previewSrc));
  check(`${fn} is in the catalog`, hasToken(catalog, fn));
}

console.log("4. catalog names every sending file (whole path)");
for (const file of new Set(sites.map((s) => s.file))) {
  check(`${file} is in the catalog`, hasToken(catalog, file));
}

console.log(failures === 0 ? "\nAll email catalog checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
