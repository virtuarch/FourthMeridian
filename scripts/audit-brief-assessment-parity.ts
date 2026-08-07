/**
 * scripts/audit-brief-assessment-parity.ts
 *
 * v2.6-BRIEF-1 — the measuring instrument for the "Brief → computeAssessment"
 * convergence. READ-ONLY: it writes nothing, ever.
 *
 * ── The question it answers ─────────────────────────────────────────────────
 *
 * `app/api/brief/route.ts` states financial conclusions — a savings rate, a
 * debt-ratio verdict, a cash-ratio verdict, a "Low cash position" warning —
 * from inline arithmetic over the assembled context. `computeAssessment`
 * (lib/ai/intelligence) is the deterministic authority that answers those same
 * questions for the AI. Two implementations of "how am I doing?" is the same
 * duplicate-authority shape this arc has spent ten slices removing.
 *
 * The obvious convergence — have the Brief call `computeAssessment` — is a trap,
 * and this probe exists to prove it BEFORE any behaviour changes. The Brief
 * builds its context with `scopeHint: 'brief'`, and that hint does not merely
 * shrink the payload: it withholds inputs `computeAssessment` reads, without
 * telling it. The engine cannot distinguish "absent because the corpus is thin"
 * from "absent because the payload was truncated", so it reports the truncation
 * as a finding about the user's finances, at full confidence.
 *
 * ── What this probe measures, and what it deliberately does not ─────────────
 *
 * It holds EVERYTHING constant except `scopeHint`, assembles the REAL
 * TRANSACTIONS_SUMMARY domain at both scopes through the REAL assembler
 * registry (the same call the context builder makes), runs the REAL
 * `computeAssessment` over each, and diffs the conclusions. Any difference is
 * caused by the hint alone — it cannot be a corpus artefact, because both arms
 * read the same corpus.
 *
 * ⚠️ It measures the TRANSACTIONS domain only. The ACCOUNTS and SNAPSHOT
 * assemblers reach `lib/account-privacy.ts` → `server-only`, which only Next
 * resolves, so no tsx probe can invoke them (the same constraint documented in
 * scripts/capture-assembler-snapshot.ts and lib/data/banking-population.ts).
 * Claiming to measure them here would be exactly the "probe that is not the live
 * path" failure v2.6-TRUTH-8 was caused by. Their scope degradations are pinned
 * STRUCTURALLY instead, over fixtures, in
 * lib/ai/intelligence/brief-scope-adequacy.test.ts — asserted where they can be
 * asserted honestly, rather than measured where they cannot.
 *
 * ── Tier ────────────────────────────────────────────────────────────────────
 *
 * INFORMATIONAL. It reports a corpus: how many Spaces currently drift and by how
 * much. A drift count is a fact about this database, not an invariant, so it must
 * never gate a build (scripts/audit-registry.ts). The INVARIANT — that the Brief
 * never states a conclusion computeAssessment would not state, and never states
 * one from a context that cannot support it — is pinned by the unit test above,
 * which runs in CI on fixtures and needs no corpus at all.
 *
 * Run: npx tsx --env-file=.env.local scripts/audit-brief-assessment-parity.ts
 */

// Side-effect import of the ONE assembler under test — deliberately NOT the
// lib/ai/assemblers barrel, whose accounts.ts → lib/account-privacy.ts chain
// pulls in 'server-only' and cannot load under tsx outside Next.js.
import "@/lib/ai/assemblers/transactions";
import { getAssembler } from "@/lib/ai/assembler-registry";
import { FinanceDomains, type SpaceContext_AI, type ContextDomainSection } from "@/lib/ai/types";
import { computeAssessment } from "@/lib/ai/intelligence";
import { db } from "@/lib/db";
import type { SpaceContext } from "@/lib/space";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const money = (n: number | null) =>
  n === null ? "(none)" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The conclusions the Brief either states today or would state once converged.
 * Every one of these is read from the assessment the AI already trusts.
 */
interface Conclusions {
  incomeTransactionCount: number;
  incomeConfidence:       string;
  cashFlowReliability:    string;
  deficitCause:           string;
  currentStatePriority:   string;
  estimatedMonthlyExpenses: number | null;
  impliedMonthlyIncome:     number | null;
  incompleteIncomeWarning:  boolean;
}

function conclusionsOf(ctx: SpaceContext_AI): Conclusions {
  const a = computeAssessment(ctx);
  return {
    incomeTransactionCount:   a.dataQuality.incomeTransactionCount,
    incomeConfidence:         a.dataQuality.incomeConfidence,
    cashFlowReliability:      a.cashFlow.reliability,
    deficitCause:             a.cashFlow.deficitCause,
    currentStatePriority:     a.currentStatePriority,
    estimatedMonthlyExpenses: a.cashFlow.estimatedMonthlyExpenses,
    impliedMonthlyIncome:     a.cashFlow.impliedMonthlyIncome,
    incompleteIncomeWarning:  a.cashFlow.incompleteIncomeWarning,
  };
}

/**
 * A SYNTHETIC snapshot domain, identical in both arms.
 *
 * ⚠️ Why this is here, and why it is not cheating. `computeAssessment` gates its
 * whole confidence ladder on `snapshotCount` FIRST: with no snapshot domain,
 * `transactionHistoryCompleteness` is 'LOW' unconditionally, which forces
 * `incomeConfidence` to 'LOW' in BOTH arms and hides the very drift this probe
 * exists to measure. A probe whose own scaffolding masks the defect is the
 * failure mode, not the measurement.
 *
 * So the snapshot input is held CONSTANT and generous (60 days — above
 * SNAPSHOT_HIGH_THRESHOLD) across brief and full. It is the same value in both
 * arms, so it cannot itself produce a difference; it only stops the ladder from
 * being short-circuited before the transactions domain is ever consulted. Any
 * difference that appears is still caused by `scopeHint` alone.
 *
 * `history: []` mirrors what the real snapshot assembler emits under
 * scopeHint='brief' (lib/ai/assemblers/snapshot.ts) — the second scope
 * degradation, held constant here and pinned structurally in the unit test.
 */
const CONSTANT_SNAPSHOT: ContextDomainSection = {
  domain:      FinanceDomains.SNAPSHOT_HISTORY,
  assembledAt: "1970-01-01T00:00:00.000Z",
  data:        { snapshotCount: 60, history: [], netWorthTrend: 0, netWorthTrendPct: 0 },
};

/** A context carrying exactly one assembled domain — everything else held equal. */
function contextWith(
  spaceId: string, userId: string, section: ContextDomainSection,
  opts: { withSnapshot: boolean },
): SpaceContext_AI {
  return {
    requestedAt:     new Date().toISOString(),
    spaceId,
    userId,
    role:            "OWNER",
    agentId:         "probe",
    resolvedDomains: [FinanceDomains.TRANSACTIONS_SUMMARY],
    space:           { id: spaceId, name: "probe", type: "PERSONAL", category: "PERSONAL" },
    domains: {
      [FinanceDomains.TRANSACTIONS_SUMMARY]: section,
      ...(opts.withSnapshot ? { [FinanceDomains.SNAPSHOT_HISTORY]: CONSTANT_SNAPSHOT } : {}),
    },
    signals:         [],
    auditLogId:      "probe",
  };
}

async function main(): Promise<void> {
  console.log(`\n[AUDIT] Brief → computeAssessment parity — READ-ONLY`);
  console.log(`  Varies ONLY scopeHint. Both arms read the same corpus, the same day.`);

  const assemble = getAssembler(FinanceDomains.TRANSACTIONS_SUMMARY);
  if (!assemble) {
    console.error("  ✗ TRANSACTIONS_SUMMARY assembler is not registered.");
    process.exitCode = 1;
    return;
  }

  // Every Space the Brief would build a context for: an ACTIVE OWNER exists.
  const spaces = await db.space.findMany({
    where:  { archivedAt: null, deletedAt: null },
    select: { id: true, name: true, type: true, category: true, isPublic: true, reportingCurrency: true },
  });

  let drifting = 0;
  let measured = 0;
  const incomeLostSpaces: string[] = [];

  for (const space of spaces) {
    const owner = await db.spaceMember.findFirst({
      where:  { spaceId: space.id, role: "OWNER", status: "ACTIVE" },
      select: { userId: true },
    });
    if (!owner) continue;

    const spaceCtx: SpaceContext = {
      userId: owner.userId,
      spaceId: space.id,
      role: "OWNER",
      permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
      space: {
        id: space.id, name: space.name, type: space.type,
        category: space.category, isPublic: space.isPublic,
        reportingCurrency: space.reportingCurrency,
      },
    };

    const [briefSection, fullSection] = await Promise.all([
      assemble(spaceCtx, { scopeHint: "brief" }),
      assemble(spaceCtx, { scopeHint: "full"  }),
    ]);
    if (!briefSection || !fullSection) continue;
    measured++;

    // Two arms, each varying ONLY scopeHint. The second admits the constant
    // snapshot so the confidence ladder can actually run — see CONSTANT_SNAPSHOT.
    const brief = conclusionsOf(contextWith(space.id, owner.userId, briefSection, { withSnapshot: false }));
    const full  = conclusionsOf(contextWith(space.id, owner.userId, fullSection,  { withSnapshot: false }));
    const briefS = conclusionsOf(contextWith(space.id, owner.userId, briefSection, { withSnapshot: true }));
    const fullS  = conclusionsOf(contextWith(space.id, owner.userId, fullSection,  { withSnapshot: true }));

    // Did the Income entry survive the brief-scope `byCategory.slice(0, 5)`?
    // `total` is the DEBIT-ONLY sum (KD-17), so Income — an inflow category —
    // sorts to the BOTTOM and is the first thing the slice discards. Its `count`
    // is the ONLY source of `incomeTransactionCount`, which gates income
    // confidence, cash-flow reliability and the whole priority ladder.
    const catsOf = (s: ContextDomainSection) =>
      (s.data as { byCategory?: { category: string }[] }).byCategory ?? [];
    const incomeInBrief = catsOf(briefSection).some((c) => c.category === "Income");
    const incomeInFull  = catsOf(fullSection).some((c) => c.category === "Income");

    const KEYS = Object.keys(full) as (keyof Conclusions)[];
    const diffs  = KEYS.filter((k) => brief[k]  !== full[k]);
    const diffsS = KEYS.filter((k) => briefS[k] !== fullS[k]);

    if (diffs.length === 0 && diffsS.length === 0 && incomeInBrief === incomeInFull) {
      console.log(`\n  ✓ ${space.name}  — brief and full scope agree`);
      continue;
    }

    drifting++;
    const fmt = (v: unknown) => (typeof v === "number" ? money(v) : String(v));
    console.log(`\n  ⚠ ${space.name}  (${space.id})`);
    console.log(`      byCategory entries : brief ${catsOf(briefSection).length}  full ${catsOf(fullSection).length}`);
    console.log(`      Income entry present: brief ${incomeInBrief ? "yes" : "NO  ← dropped by slice(0,5)"}  full ${incomeInFull ? "yes" : "no"}`);
    if (incomeInFull && !incomeInBrief) incomeLostSpaces.push(space.name);

    if (diffs.length) {
      console.log(`      — as the Brief builds context today (no snapshot history reaches the engine):`);
      for (const k of diffs) {
        console.log(`        ${k.padEnd(26)} brief=${fmt(brief[k]).padEnd(16)} full=${fmt(full[k])}`);
      }
    }
    // The consequence the first arm cannot show: with a snapshot span present —
    // held IDENTICAL in both arms — the truncated Income count propagates all the
    // way into confidence, reliability and the priority ladder.
    const onlyWithSnapshot = diffsS.filter((k) => !diffs.includes(k));
    if (onlyWithSnapshot.length) {
      console.log(`      — additionally, once a snapshot span lets the confidence ladder run:`);
      for (const k of onlyWithSnapshot) {
        console.log(`        ${k.padEnd(26)} brief=${fmt(briefS[k]).padEnd(16)} full=${fmt(fullS[k])}`);
      }
    }
  }

  bar("VERDICT");
  console.log(`  Spaces measured                     : ${measured}`);
  console.log(`  Spaces whose CONCLUSIONS move on the hint alone: ${drifting}`);
  console.log(`  Spaces where brief scope DROPS the Income category: ${incomeLostSpaces.length}` +
    (incomeLostSpaces.length ? `  (${incomeLostSpaces.join(", ")})` : ""));

  if (drifting > 0) {
    console.log(
      `\n  ⚠ scopeHint is not a payload-size knob. It changes what computeAssessment\n` +
      `    concludes about the user's finances, with no signal that anything was\n` +
      `    withheld. A Brief that calls computeAssessment over a 'brief' context\n` +
      `    would publish these differences as findings.\n`,
    );
  } else {
    console.log(`\n  ✓ no conclusion moves on the hint alone.\n`);
  }
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => { console.error(err); await db.$disconnect(); process.exitCode = 1; });
