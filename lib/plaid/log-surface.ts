/**
 * lib/plaid/log-surface.ts — FM-AUDIT-001
 *
 * The Plaid LOGGING SURFACE and the scan that keeps it safe: every file that
 * talks to Plaid (or orchestrates a Plaid pipeline) must hand a caught error to a
 * console call only through `redactedErrorForLog` / `plaidErrorSummary` — never
 * as a raw object, whose serialisation is exactly what leaked PLAID-SECRET on
 * 2026-07-22. The client-level sanitiser (lib/plaid/client.ts) already makes a
 * raw Plaid error harmless; this scan keeps the second layer from eroding.
 *
 * Pure (fs reads only). Used by plaid-log-safety.test.ts; exported so the surface
 * definition lives in ONE place.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Directories whose every non-test .ts file is Plaid surface. */
export const PLAID_SURFACE_DIRS = [
  "lib/plaid",
  "app/api/plaid",
  "app/api/admin/plaid",
  "app/api/connections",
  "app/api/platform/platform-ops/connections",
] as const;

/** Pipeline orchestrators outside those dirs that run Plaid calls in their try blocks. */
export const PLAID_SURFACE_FILES = [
  "jobs/sync-banks.ts",
  "jobs/resume-stale-imports.ts",
  "lib/investments/investment-event-ingest.ts",
  "lib/account-deletion/purge.ts",
  "app/api/accounts/[id]/sync/route.ts",
  "scripts/cleanup-orphaned-plaid-items.ts",
  "scripts/diagnose-invalid-plaid-tokens.ts",
  "scripts/recover-plaid-item-transactions.ts",
  "scripts/dev-reset-test-state.ts",
  "scripts/purge-plaid-connection.ts",
] as const;

/** Any file importing the Plaid client is surface too (scripts included). */
const CLIENT_IMPORT = /(?:from\s+|import\s*\(\s*)["'](?:@\/|(?:\.\.\/)+)lib\/plaid\/client["']/;

function walk(dir: string, root: string): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(rel, root));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

export function plaidSurfaceFiles(root: string): string[] {
  const set = new Set<string>();
  for (const d of PLAID_SURFACE_DIRS) for (const f of walk(d, root)) set.add(f);
  for (const f of PLAID_SURFACE_FILES) set.add(f);
  for (const d of ["lib", "app", "jobs", "scripts"]) {
    for (const f of walk(d, root)) {
      if (CLIENT_IMPORT.test(readFileSync(path.join(root, f), "utf8"))) set.add(f);
    }
  }
  return [...set].sort();
}

/** A console argument that is a bare caught-error identifier (or member of one). */
const RAW_ERROR_ARG = /^(?:[A-Za-z_$][\w$]*\.)*(?:e|ex|exc|err|error|reason|cause|[A-Za-z_$][\w$]*(?:Err|Error|Exception))$/;

export interface RawErrorLog { file: string; line: number; call: string; arg: string; argStart: number }

/** Split `a, b(c, d), e` at depth-0 commas, respecting strings/templates. */
function topLevelArgs(src: string): Array<{ text: string; offset: number }> {
  const args: Array<{ text: string; offset: number }> = [];
  let depth = 0, from = 0, quote: string | null = null;
  const push = (end: number) => {
    const raw = src.slice(from, end);
    const lead = raw.length - raw.trimStart().length;
    if (raw.trim()) args.push({ text: raw.trim(), offset: from + lead });
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) { push(i); from = i + 1; }
  }
  push(src.length);
  return args;
}

/** Blank out comments (keeping newlines, so line numbers survive). */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/^(\s*)(\/\/.*)$/gm, (_m, ws: string, c: string) => ws + " ".repeat(c.length));
}

/** Every `console.x(...)` in `text` whose argument list carries a raw error. */
export function findRawErrorLogs(file: string, source: string): RawErrorLog[] {
  const text = stripComments(source);
  const found: RawErrorLog[] = [];
  const re = /console\.(?:log|info|warn|error|debug)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // find the matching close paren (string/template aware)
    let i = m.index + m[0].length, depth = 1, quote: string | null = null;
    const start = i;
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i];
      if (quote) { if (ch === "\\") { i++; continue; } if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    const inner = text.slice(start, i - 1);
    for (const arg of topLevelArgs(inner)) {
      if (RAW_ERROR_ARG.test(arg.text)) {
        found.push({
          file,
          line: text.slice(0, m.index).split("\n").length,
          call: text.slice(m.index, Math.min(i, m.index + 120)).replace(/\s+/g, " "),
          arg: arg.text,
          argStart: start + arg.offset,
        });
      }
    }
  }
  return found;
}
