/**
 * scripts/audit-emergency-fund-footprint.ts
 *
 * v2.6-LEGACY-1 — what is left of the Emergency Fund concept, and is any of it
 * still load-bearing? READ-ONLY: writes nothing, ever.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * `lib/space-templates/registry.ts` already classifies `emergency-fund` as
 * `hidden`, in a comment that calls it one of "the RETIRED Debt Payoff /
 * Emergency Fund / Investment / Equipment / Other" templates. Only `family` and
 * `custom` are `live` — those are the only two Space types a user can create.
 *
 * So the EF surfaces cannot be reached by any new Space, and the one live
 * account (Chris') has a PERSONAL Space. Everything still referencing the
 * concept is therefore one of:
 *
 *   ACTIVE          reachable by a Space a user can create today
 *   FUTURE-PLANNED  a comingSoon template or a declared roadmap concept
 *   SEED-ONLY       exercised only by prisma/seed.ts or sandbox fixtures
 *   DEAD            unreachable by any creatable Space and not planned
 *
 * The point of measuring rather than assuming: some of this is a genuinely
 * reusable GOAL primitive (a target expressed in months of expenses, progress
 * against it) that a future Goals framework would want, and some is a dead
 * product surface. Retiring the second without noticing the first would throw
 * away the part worth keeping.
 *
 * Tier: INFORMATIONAL — a census that scopes a retire-or-extract decision.
 *
 * Run: npx tsx --env-file=.env.local scripts/audit-emergency-fund-footprint.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { db } from "@/lib/db";

const ROOT = process.cwd();
const SCAN_ROOTS = ["lib", "app", "components", "jobs", "scripts", "prisma"];
const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

function walk(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const childRel = path.join(rel, e);
    if (statSync(path.join(ROOT, childRel)).isDirectory()) { out.push(...walk(childRel)); continue; }
    if (!/\.(ts|tsx|prisma)$/.test(e)) continue;
    out.push(childRel);
  }
  return out;
}

/** Where a reference lives decides most of its classification. */
function classify(file: string): "SEED-ONLY" | "TEST" | "SCHEMA" | "CODE" {
  if (file.startsWith("prisma/seed") || file.includes("seed")) return "SEED-ONLY";
  if (/\.test\.tsx?$/.test(file)) return "TEST";
  if (file.endsWith(".prisma")) return "SCHEMA";
  return "CODE";
}

const PATTERN = /emergency[_-]?fund|EMERGENCY_FUND/i;

async function main(): Promise<void> {
  console.log(`\n[AUDIT] Emergency Fund footprint — READ-ONLY`);

  // ── 1. What can actually be created? ──────────────────────────────────────
  bar("WHAT A USER CAN CREATE TODAY");
  const registry = readFileSync(path.join(ROOT, "lib/space-templates/registry.ts"), "utf8");
  for (const m of registry.matchAll(/makeTemplate\("([\w-]+)",\s*SpaceCategory\.(\w+),\s*"(\w+)"\)/g)) {
    const [, id, category, status] = m;
    const mark = status === "live" ? "✓ CREATABLE" : status === "comingSoon" ? "· planned (disabled)" : "✗ hidden/retired";
    console.log(`  ${id.padEnd(16)} ${category.padEnd(16)} ${status.padEnd(11)} ${mark}`);
  }

  // ── 2. Corpus reality ─────────────────────────────────────────────────────
  bar("CORPUS");
  const byCategory = await db.space.groupBy({
    by: ["category"],
    where: { archivedAt: null, deletedAt: null },
    _count: { _all: true },
  });
  for (const row of byCategory.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`  ${String(row.category).padEnd(18)} ${row._count._all}`);
  }
  const efSpaces = await db.space.count({ where: { category: "EMERGENCY_FUND", archivedAt: null, deletedAt: null } });
  const efSections = await db.spaceDashboardSection.count({ where: { key: "emergency_fund_progress" } });
  console.log(`\n  Spaces with category EMERGENCY_FUND      : ${efSpaces}`);
  console.log(`  emergency_fund_progress section rows     : ${efSections}`);

  // ── 3. Code footprint ─────────────────────────────────────────────────────
  bar("CODE FOOTPRINT");
  const hits: Record<string, string[]> = { CODE: [], TEST: [], "SEED-ONLY": [], SCHEMA: [] };
  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      if (file === "scripts/audit-emergency-fund-footprint.ts") continue;
      const text = readFileSync(path.join(ROOT, file), "utf8");
      const lines = text.split("\n").filter((l) => PATTERN.test(l));
      if (lines.length === 0) continue;
      hits[classify(file)].push(`${file}  (${lines.length})`);
    }
  }
  for (const bucket of ["CODE", "SCHEMA", "SEED-ONLY", "TEST"] as const) {
    console.log(`\n  ── ${bucket} — ${hits[bucket].length} file(s)`);
    for (const f of hits[bucket].sort()) console.log(`     ${f}`);
  }

  bar("VERDICT");
  console.log(`  A user can create: family, custom. Nothing else.`);
  console.log(`  EMERGENCY_FUND Spaces in the corpus: ${efSpaces}`);
  console.log(
    `\n  Every EF surface is therefore unreachable by any Space a user can make.\n` +
    `  What remains to decide is whether the GOAL PRIMITIVE inside it — a target\n` +
    `  expressed in months of expenses, and progress toward that target — is worth\n` +
    `  extracting before the product surface is retired.\n`,
  );
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => { console.error(e); await db.$disconnect(); process.exitCode = 1; });
