/**
 * lib/platform/seed.test.ts  (PLATFORM-OPS-UI-PARITY §2)
 *
 * The platform-section reconciliation contract, proven against an in-memory
 * fake of the two Prisma calls it makes. No database.
 *
 *   npx tsx lib/platform/seed.test.ts
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `ensurePlatformSections` was create-only. That protected operator edits — and
 * also froze OUR OWN constants: renaming a section in PLATFORM_AREAS changed the
 * code and nothing else, so the sidebar kept rendering a label the registry no
 * longer declared. The fix is not "update everything"; it is a split between
 * metadata the system owns and configuration an operator owns. This pins that
 * split, because the dangerous regression in either direction is silent:
 *
 *   too little → the sidebar disagrees with the code, forever
 *   too much   → a re-run silently re-enables a section an operator disabled
 */

import { PLATFORM_AREAS, ALL_PLATFORM_AREAS } from "./policy";
import { ensurePlatformSections } from "./seed";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

interface Row {
  spaceId: string; key: string; label: string;
  tab: string; enabled: boolean; order: number;
  /** Bumped by any write, so a no-op re-run is observable. */
  writes: number;
}

/**
 * The narrowest fake that can tell the difference between "created", "converged"
 * and "left alone" — and counts writes, so strict idempotence is provable rather
 * than asserted.
 */
function makeClient(seed: Row[] = []) {
  const rows: Row[] = seed.map((r) => ({ ...r }));
  const spaces = ALL_PLATFORM_AREAS.map((a) => ({ id: `space-${a}`, platformArea: a }));
  let creates = 0, updates = 0;
  return {
    rows,
    stats: () => ({ creates, updates }),
    space: {
      findUnique: async ({ where }: { where: { platformArea: string } }) =>
        spaces.find((s) => s.platformArea === where.platformArea) ?? null,
    },
    spaceDashboardSection: {
      findUnique: async ({ where }: { where: { spaceId_key: { spaceId: string; key: string } } }) =>
        rows.find((r) => r.spaceId === where.spaceId_key.spaceId && r.key === where.spaceId_key.key) ?? null,
      create: async ({ data }: { data: Omit<Row, "writes"> }) => {
        creates += 1;
        rows.push({ ...data, writes: 1 });
        return data;
      },
      updateMany: async ({ where, data }: { where: { spaceId: string; key: string }; data: Partial<Row> }) => {
        const hit = rows.filter((r) => r.spaceId === where.spaceId && r.key === where.key);
        for (const r of hit) { Object.assign(r, data); r.writes += 1; updates += 1; }
        return { count: hit.length };
      },
    },
  };
}

const OPS = "space-PLATFORM_OPS";
const row = (over: Partial<Row> & { key: string }): Row => ({
  spaceId: OPS, label: "x", tab: "OVERVIEW", enabled: true, order: 0, writes: 0, ...over,
});
/** The canonical label the registry currently declares for a key. */
const declared = (key: string) =>
  PLATFORM_AREAS.PLATFORM_OPS.sections.find((s) => s.key === key)!.label;

async function main() {
  // ── 1. A missing row is created ─────────────────────────────────────────────
  console.log("1. a missing section row is created");
  {
    const c = makeClient();
    const res = await ensurePlatformSections(c as never);
    const health = c.rows.find((r) => r.spaceId === OPS && r.key === "ops_platform_health");
    check("ops_platform_health is created", health != null);
    check("…enabled", health?.enabled === true);
    check("…with the registry's order", health?.order === PLATFORM_AREAS.PLATFORM_OPS.sections.find((s) => s.key === "ops_platform_health")!.order);
    check("…with the registry's label", health?.label === declared("ops_platform_health"));
    check("…on the OVERVIEW tab", health?.tab === "OVERVIEW");
    const declaredTotal = ALL_PLATFORM_AREAS.reduce((n, a) => n + PLATFORM_AREAS[a].sections.length, 0);
    check("every declared section across every area is created",
      res.created === declaredTotal && c.rows.length === declaredTotal, `${res.created}/${declaredTotal}`);
    check("nothing was relabelled on a fresh seed", res.relabelled === 0);
  }

  // ── 2. A stale canonical label converges ────────────────────────────────────
  console.log("2. a stale SYSTEM-OWNED label is updated");
  {
    // Exactly the shipped situation: the row was seeded as "Job Health" before
    // the registry renamed it to "Jobs".
    const c = makeClient([row({ key: "ops_job_health", label: "Job Health", order: 0 })]);
    const res = await ensurePlatformSections(c as never);
    const jobs = c.rows.find((r) => r.spaceId === OPS && r.key === "ops_job_health")!;
    check("the label converges on the registry", jobs.label === declared("ops_job_health"), jobs.label);
    check("the registry declares 'Jobs'", declared("ops_job_health") === "Jobs");
    check("the drift is reported", res.relabelled === 1, `${res.relabelled}`);
    check("the row was UPDATED, not recreated", res.created < c.rows.length);
  }

  // ── 3. Operator-owned state survives ────────────────────────────────────────
  console.log("3. operator-owned configuration is preserved");
  {
    // An operator disabled the section and moved it. Reconciliation must fix the
    // label WITHOUT undoing either — re-enabling a deliberately hidden surface
    // is the silent regression this guard exists for.
    const c = makeClient([row({ key: "ops_job_health", label: "Job Health", enabled: false, order: 97 })]);
    await ensurePlatformSections(c as never);
    const jobs = c.rows.find((r) => r.key === "ops_job_health" && r.spaceId === OPS)!;
    check("label converged", jobs.label === "Jobs");
    check("enabled=false is PRESERVED (not reset to true)", jobs.enabled === false);
    check("operator order is PRESERVED", jobs.order === 97, `${jobs.order}`);

    // …and the same holds when the label needed no change at all.
    const c2 = makeClient([row({ key: "ops_job_health", label: "Jobs", enabled: false, order: 42 })]);
    const res2 = await ensurePlatformSections(c2 as never);
    const j2 = c2.rows.find((r) => r.key === "ops_job_health" && r.spaceId === OPS)!;
    check("an already-correct row is not touched", j2.writes === 0 && res2.relabelled === 0);
    check("…and keeps enabled/order", j2.enabled === false && j2.order === 42);
  }

  // ── 4. Idempotence, in the strict sense ─────────────────────────────────────
  console.log("4. a second run writes nothing at all");
  {
    const c = makeClient([row({ key: "ops_job_health", label: "Job Health", enabled: false, order: 5 })]);
    await ensurePlatformSections(c as never);
    const afterFirst = c.stats();
    const snapshot = JSON.stringify(c.rows);

    const res2 = await ensurePlatformSections(c as never);
    const afterSecond = c.stats();
    check("second run creates nothing", afterSecond.creates === afterFirst.creates && res2.created === 0);
    check("second run updates nothing", afterSecond.updates === afterFirst.updates && res2.relabelled === 0);
    // Strict: no write at all, so `updatedAt` cannot churn on a no-op re-run.
    check("no row was written on the second run", JSON.stringify(c.rows) === snapshot);

    const third = await ensurePlatformSections(c as never);
    check("third run is also inert", third.created === 0 && third.relabelled === 0);
  }

  // ── 5. Scope — reconciliation cannot reach beyond its own row ───────────────
  console.log("5. convergence is scoped to (spaceId, key)");
  {
    // A customer Space happens to hold a section with the SAME key. It must not
    // be touched: the updateMany is scoped by spaceId as well as key.
    const foreign = row({ spaceId: "space-CUSTOMER-XYZ", key: "ops_job_health", label: "Job Health", enabled: false, order: 3 });
    const c = makeClient([foreign, row({ key: "ops_job_health", label: "Job Health" })]);
    await ensurePlatformSections(c as never);
    const other = c.rows.find((r) => r.spaceId === "space-CUSTOMER-XYZ")!;
    check("a same-key row in another Space is untouched",
      other.label === "Job Health" && other.writes === 0 && other.enabled === false);
    check("…while the platform row converged",
      c.rows.find((r) => r.spaceId === OPS && r.key === "ops_job_health")!.label === "Jobs");
  }

  // ── 6. An absent Space is skipped, not thrown on ────────────────────────────
  console.log("6. a missing Space is defensive, not fatal");
  {
    const c = makeClient();
    c.space.findUnique = async () => null;
    const res = await ensurePlatformSections(c as never);
    check("no rows written", c.rows.length === 0 && res.created === 0 && res.relabelled === 0);
  }

  if (failures > 0) { console.error(`\nseed.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nseed.test: all passed.");
}

void main();
