/**
 * lib/platform-surface.test.ts  (PO1.0 §2.8)
 *
 * Standalone tsx script (house pattern of lib/security-surface.test.ts) — a
 * SOURCE-SCAN test: reads platform module/route source as text and asserts the
 * PO1.0 architectural floor cannot silently regress. Deterministic, no runtime,
 * no DB.
 *
 * Five load-bearing tripwires (§2.8):
 *   1. Platform code never gates on the CUSTOMER axis — no `can(`,
 *      `requireSpaceRole`, `requireSpaceAction`, `SpaceMemberRole` anywhere
 *      under lib/platform, app/(shell)/dashboard/platform, or app/api/platform
 *      (07-07 risk #2: axis confusion).
 *   2. The grant routes carry their guard floor — `requireFreshSystemAdmin`,
 *      `limitByUser`, and `AuditAction.PLATFORM_GRANT` (07-07 risk #6).
 *   3. POST /api/spaces never reads `platformArea` from the request body
 *      (platform Spaces are never client-creatable).
 *   4. The seed's upsert has an empty `update: {}` (a re-run never mutates a
 *      live platform Space).
 *   5. No `spaceMember.create` under lib/platform or the grant routes
 *      (visibility stays access-derived — no dual source of truth).
 *
 * Tolerant of not-yet-created files: the platform app dirs (S7) and the grant
 * routes (S5) may not exist when an earlier slice runs this. Absence-scans (1,
 * 5) pass vacuously; presence-scans (2) are pinned once the files exist and
 * report a pending note until then — a regression after they land fails here.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const src = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

/** Recursively collect *.ts / *.tsx under a repo-relative dir; [] if absent. */
function filesUnder(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const childRel = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(childRel));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(childRel);
  }
  return out;
}

/** Strip block + line comments so prose that names a forbidden token (e.g. a
 *  boundary-documenting comment) does not trip a code scan. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ── Roots ─────────────────────────────────────────────────────────────────────

const PLATFORM_ROOTS = [
  "lib/platform",
  "app/(shell)/dashboard/platform",
  "app/api/platform",
];
const GRANT_ROUTE_ROOT = "app/api/admin/platform-grants";

// ── Tripwire 1 — no customer-axis gating in platform code ─────────────────────

console.log("1. Platform code never gates on the customer (SpaceMember) axis");
{
  // This test file itself lives under lib/ but not lib/platform, so it is not
  // scanned. Each pattern is matched against comment-stripped code only.
  const forbidden: [string, RegExp][] = [
    ["can(",                /\bcan\(/],
    ["requireSpaceRole",    /\brequireSpaceRole\b/],
    ["requireSpaceAction",  /\brequireSpaceAction\b/],
    ["SpaceMemberRole",     /\bSpaceMemberRole\b/],
  ];
  const files = PLATFORM_ROOTS.flatMap(filesUnder);
  let scanned = 0;
  for (const file of files) {
    const code = stripComments(src(file));
    scanned++;
    for (const [label, re] of forbidden) {
      check(`${file} has no \`${label}\``, !re.test(code), "customer-axis token in platform code");
    }
  }
  check(`scanned ≥ the 3 shipped lib/platform modules (got ${scanned})`, scanned >= 3);
}

// ── Tripwire 2 — grant routes carry their guard floor ─────────────────────────

console.log("2. Grant routes carry fresh-auth + rate-limit + canon audit");
{
  const files = filesUnder(GRANT_ROUTE_ROOT);
  if (files.length === 0) {
    console.log("  · (pending — grant routes not yet created; pinned once S5 lands)");
  } else {
    const all = files.map(src).join("\n");
    check("grant routes reference requireFreshSystemAdmin", all.includes("requireFreshSystemAdmin"));
    check("grant routes reference limitByUser",             all.includes("limitByUser"));
    check("grant routes reference AuditAction.PLATFORM_GRANT", all.includes("AuditAction.PLATFORM_GRANT"));
  }
}

// ── Tripwire 3 — POST /api/spaces never reads platformArea from the body ──────

console.log("3. POST /api/spaces does not read platformArea from the request body");
{
  const spaces = src("app/api/spaces/route.ts");
  const postIdx = spaces.indexOf("export const POST");
  check("app/api/spaces/route.ts has a POST handler", postIdx >= 0);
  // GET (which DOES read platformArea after S7) precedes POST in the file, so
  // slicing from POST isolates the create handler.
  const postSlice = postIdx >= 0 ? spaces.slice(postIdx) : "";
  check("POST handler never references platformArea", !postSlice.includes("platformArea"));
}

// ── Tripwire 4 — the seed's upsert never mutates a live platform Space ────────

console.log("4. Seed upsert has an empty update: {}");
{
  const seed = src("lib/platform/seed.ts");
  check("lib/platform/seed.ts upsert uses update: {}", /update:\s*\{\s*\}/.test(seed));
}

// ── Tripwire 5 — no SpaceMember rows are ever written for platform Spaces ──────

console.log("5. No spaceMember.create under lib/platform or the grant routes");
{
  const files = [...filesUnder("lib/platform"), ...filesUnder(GRANT_ROUTE_ROOT)];
  for (const file of files) {
    check(`${file} has no spaceMember.create`, !/spaceMember\.create/i.test(src(file)));
  }
  check(`scanned ≥ the 3 shipped lib/platform modules (got ${files.length})`, files.length >= 3);
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log(
  failures === 0 ? "\nAll platform-surface scans passed." : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
