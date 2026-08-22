/**
 * scripts/audit-goals-tombstone.ts   (W2 — Goals/Retirement retirement)
 *
 * THE GOALS TOMBSTONE SCAN. Source-only, no database.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 *
 * NO RUNTIME PATH READS OR WRITES GOAL STATE, AND NO SURFACE SPEAKS THE
 * RETIRED GOALS VOCABULARY.
 *
 * W2 retired Goals and Retirement as product concepts: routes, components, the
 * AI goals domain (assembler, detector, signal, alignment engine, intent),
 * seeding, purge arms and the section render stack are gone. What remains is
 * SCHEMA ONLY (SpaceGoal / GoalCheckIn / GoalContribution + their enums), kept
 * until the enum/table-retirement migration train — unreadable and unwritable
 * from code. The assessment vocabulary carries no intent-shaped deficit cause:
 * declared debt-paydown intent has no declaration mechanism and is never
 * guessed from activity (its recorded future home is debt planning/strategy).
 *
 * This scan is what keeps that a fact instead of a moment: any new code-side
 * reference to the goal models, the retired AI vocabulary, or the retired
 * section keys fails the build until it arrives WITH a conscious architecture
 * (the migration train, or the debt-planning authority) and an updated scan.
 *
 * ── Mechanics ───────────────────────────────────────────────────────────────
 *
 * Non-test source under lib/ app/ components/ jobs/ scripts/ types/ context/,
 * comments stripped (tombstone comments are encouraged and never counted),
 * prisma/ excluded entirely (schema + migrations legitimately name the models
 * until the train drops them). Test files are excluded: absence PINS must name
 * the things they pin. This file excludes itself.
 *
 * Tier: REQUIRED — corpus-independent (source is the corpus). ✗ ⇒ exit 1.
 *
 * Run: npx tsx scripts/audit-goals-tombstone.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

const SCAN_ROOTS = ["lib", "app", "components", "jobs", "scripts", "types", "context"];

/** The retired vocabulary. Word-bounded identifiers — plain-English "goal(s)"
 *  in prose never matches. */
const TOMBSTONED = [
  // Prisma model/client accessors and type names
  "spaceGoal", "SpaceGoal", "goalContribution", "GoalContribution",
  "goalCheckIn", "GoalCheckIn", "GoalCategory", "GoalStatus", "GoalType",
  // The retired AI goals layer
  "getGoalsData", "computeGoalAlignment", "GoalAlignmentItem", "GoalsSectionData",
  "GOAL_COMPLETED", "GOAL_ALIGNMENT", "goalAlignment",
  // Intent-shaped deficit causes (never guessed; no declaration mechanism)
  "INTENTIONAL_DEBT_PAYOFF", "DEBT_PAYOFF_IS_INTENTIONAL",
  // Retired section/widget keys and components
  "goals_progress", "goal_progress", "goal_on_track", "goal_required_pace",
  "goal_funding_gap", "GoalsCard", "AddGoalModal", "RoutedWorkspaceModal",
] as const;
const RE = new RegExp(`\\b(${TOMBSTONED.join("|")})\\b`);

function walk(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const childRel = path.join(rel, e);
    if (statSync(path.join(ROOT, childRel)).isDirectory()) {
      if (childRel.includes("prototype")) continue;
      out.push(...walk(childRel));
      continue;
    }
    if (!/\.tsx?$/.test(e) || /\.test\.tsx?$/.test(e)) continue;
    if (childRel === path.join("scripts", "audit-goals-tombstone.ts")) continue;
    out.push(childRel);
  }
  return out;
}

/** Strip block + line comments so tombstone documentation never trips the scan. */
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

function main(): void {
  console.log(`\n[AUDIT] goals tombstone — no runtime path reads, writes, or speaks goal state\n`);

  const files = SCAN_ROOTS.flatMap(walk);
  const offenders: string[] = [];
  for (const f of files) {
    const c = code(f);
    const m = c.match(RE);
    if (m) {
      const line = c.slice(0, m.index).split("\n").length;
      offenders.push(`${f}:${line} — ${m[1]}`);
    }
  }
  check("no non-test source references the retired goals vocabulary",
    offenders.length === 0, offenders.slice(0, 10).join("\n      "));

  // The deletion set stays deleted (single-string resurrections fail here).
  for (const gone of [
    "app/api/spaces/[id]/goals",
    "components/space/sections/SectionRegistry.tsx",
    "components/space/sections/SectionCard.tsx",
    "components/space/workspaces/RoutedWorkspaceModal.tsx",
    "components/space/workspaces/AddGoalModal.tsx",
    "lib/ai/assemblers/goals.ts",
    "lib/ai/signals/detectors/goals.ts",
    "lib/goals",
    "lib/widget-registry.ts",
    "lib/perspectives/virtual-sections.ts",
    "lib/balances/section-quantity.ts",
  ]) {
    let exists = true;
    try { statSync(path.join(ROOT, gone)); } catch { exists = false; }
    check(`${gone} stays deleted`, !exists);
  }

  // The schema residue is EXACTLY the expected one (models + enums awaiting the
  // migration train) — if the models vanish from schema.prisma, the train ran
  // and THIS AUDIT should be retired with a tombstone entry in the registry.
  const schema = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");
  check("schema still carries the goal models (retire this audit when the migration train drops them)",
    /model SpaceGoal /.test(schema) && /model GoalContribution /.test(schema) && /model GoalCheckIn /.test(schema));

  if (failures > 0) {
    console.error(`\n[AUDIT] FAILED — ${failures} goals-tombstone check(s) violated.\n`);
    process.exit(1);
  }
  console.log(`\n[AUDIT] PASSED — goals are schema-only residue; no runtime path touches them. ✓\n`);
}

main();
