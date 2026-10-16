/**
 * scripts/docker-teardown.test.ts  (2026-10-16 — the throwaway-Postgres volume leak)
 *
 * Every throwaway Postgres container the CI and acceptance harnesses start is
 * `docker run -d --rm postgres:16…`. The image declares a VOLUME, so each owns an
 * anonymous volume; `--rm` frees it only when the container exits by itself, and
 * the harnesses tear down with an explicit `docker rm -f`, which WITHOUT `-v`
 * leaves the volume behind. 751 such volumes (~43 GB, one per suite per run) had
 * filled the development disk by 2026-10-16 — ENOSPC took the dev server down.
 *
 * Pinned by source scan: every `docker rm` a script under scripts/ issues — as an
 * argv array or a documented shell line — carries `-v`. Denominator first, so a
 * refactor that renames the call cannot pass by finding nothing.
 *
 *   npx tsx scripts/docker-teardown.test.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(ts|cjs|mjs|js|sh)$/.test(e.name) && rel !== path.join("scripts", "docker-teardown.test.ts")) out.push(rel);
  }
  return out;
}

// argv form: "docker", ["rm", …]   ·   shell / doc form: docker rm …
const ARGV_RM = /["']docker["']\s*,\s*\[\s*["']rm["']([^\]]*)\]/g;
// A shell line counts only when it names a container (flags, then an argument) — prose quoting "`docker rm -f`" is not a call.
const SHELL_RM = /\bdocker\s+rm((?:\s+-[-\w]+)*)\s+[\w.$][\w.$-]*/g;

const sites: { file: string; text: string; hasV: boolean }[] = [];
for (const file of walk("scripts")) {
  const src = readFileSync(path.join(ROOT, file), "utf8");
  for (const m of src.matchAll(ARGV_RM)) sites.push({ file, text: m[0], hasV: /["']-v["']|["']--volumes["']/.test(m[1]) });
  for (const m of src.matchAll(SHELL_RM)) sites.push({ file, text: m[0].trim(), hasV: /(^|\s)(-v|--volumes|-[a-z]*v[a-z]*)(?=\s|$)/.test(m[1]) });
}

const expected = ["scripts/ci-local.ts", "scripts/lib/rls-harness.ts", "scripts/rls-acceptance.ts"];
check("the three harness teardowns are found (denominator)", expected.every((f) => sites.some((s) => s.file === f)),
  `found in: ${[...new Set(sites.map((s) => s.file))].join(", ")}`);
const missing = sites.filter((s) => !s.hasV);
check(`every docker rm under scripts/ removes the container's anonymous volumes (-v) — ${sites.length} site(s)`, missing.length === 0,
  missing.map((s) => `${s.file}: ${s.text}`).join(" | "));

// The containers these pins protect are the --rm throwaways; a run without --rm would leak the container itself.
for (const f of expected) {
  const src = readFileSync(path.join(ROOT, f), "utf8");
  check(`${f}: the throwaway is started with --rm`, /"run",\s*"-d",\s*"--rm"/.test(src));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
