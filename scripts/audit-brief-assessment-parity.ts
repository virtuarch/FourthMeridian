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
 * ── Registration wiring (W3 acceptance repair) ──────────────────────────────
 *
 * Assemblers register as a SIDE-EFFECT of module load (each module calls
 * registerAssembler() at its top level — lib/ai/assembler-registry.ts), so
 * getAssembler() finds nothing unless THIS process's import graph actually
 * loaded the assembler module. Production registers everything through one
 * barrel import (lib/ai/context-builder.ts → `import '@/lib/ai/assemblers'`),
 * and this script imports THE SAME BARREL — the canonical registration path —
 * so the TRANSACTIONS and ACCOUNTS arms both run the real production
 * assemblers, not probe re-implementations.
 *
 * History: this file once imported only ./transactions, citing the accounts →
 * lib/account-privacy.ts → 'server-only' chain as un-loadable under tsx. That
 * constraint is RETIRED here: the npm script wires
 * scripts/lib/server-only-preload.cjs (see the Run note below), under which the
 * full barrel loads. W3's first cut added the ACCOUNTS parity arms without
 * adding any import that executed the ACCOUNTS registration, so the audit
 * refused at startup ("ACCOUNTS assembler is not registered") on its first real
 * run. tsc cannot catch that class — a side-effect import is wiring, not a
 * type — so the wiring is pinned BEHAVIORALLY in
 * scripts/audit-brief-assessment-parity.test.ts (spawns this script, asserts
 * the registration gate passes). The SNAPSHOT arm remains deliberately
 * synthetic and constant (see CONSTANT_SNAPSHOT below); the fixture pins in
 * lib/ai/intelligence/brief-scope-adequacy.test.ts stay the structural guards.
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
 * Run: npm run audit:brief-assessment-parity
 *
 * (Run via the npm script: this file transitively imports a module that declares
 *  `import "server-only"`, which is not an installed npm package, so bare
 *  `npx tsx` dies at module load. The npm script wires in the same preload the
 *  test runner uses — scripts/lib/server-only-preload.cjs. Nothing else changes.)
 */

// Registration side-effects: the SAME barrel production imports
// (lib/ai/context-builder.ts:38). It loads under tsx because the npm script
// wires the server-only preload. Do NOT narrow this back to individual
// assembler modules — the wiring pin (audit-brief-assessment-parity.test.ts)
// fails if ACCOUNTS or TRANSACTIONS registration becomes unreachable from this
// file's import graph.
import "@/lib/ai/assemblers";
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
  /** A2 — the deterministic trajectory verdict; must not move on the hint alone. */
  trajectory:               string;
}

/** W3 — the DEBT conclusions, measured over the ACCOUNTS domain arms. After W3
 *  the brief payload carries the DEBT_ONLY row subset — the exact rows the
 *  grade requires — so scope-hint-only debt drift is expected to be ZERO. */
interface DebtConclusions {
  classification:        string;
  confidence:            string;
  hasBalanceOnlyDebt:    boolean;
  monthlyInterestBurden: number | null;
  ungradedDebtReason:    string | null;
}

function debtConclusionsOf(ctx: SpaceContext_AI): DebtConclusions {
  const a = computeAssessment(ctx);
  return {
    classification:        a.debt.classification,
    confidence:            a.debt.confidence,
    hasBalanceOnlyDebt:    a.debt.hasBalanceOnlyDebt,
    monthlyInterestBurden: a.debt.monthlyInterestBurden,
    ungradedDebtReason:    a.ungraded.find((u) => u.section === 'debt')?.reason ?? null,
  };
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
    // A2 — the trajectory verdict joins the conclusion set this probe diffs
    // across scope hints, so a scope-sensitive trajectory becomes a MEASURED
    // failure on the real corpus, not merely a fixture assertion.
    trajectory:               a.trajectory.classification,
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
  // W3 — the ACCOUNTS arms, for debt parity.
  const assembleAccts = getAssembler(FinanceDomains.ACCOUNTS);
  if (!assembleAccts) {
    console.error("  ✗ ACCOUNTS assembler is not registered.");
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
  let debtDrifting = 0;
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

    const [briefSection, fullSection, acctsBrief, acctsFull] = await Promise.all([
      assemble(spaceCtx, { scopeHint: "brief" }),
      assemble(spaceCtx, { scopeHint: "full"  }),
      assembleAccts(spaceCtx, { scopeHint: "brief" }),
      assembleAccts(spaceCtx, { scopeHint: "full"  }),
    ]);
    if (!briefSection || !fullSection) continue;
    measured++;

    // ── W3 DEBT PARITY — vary ONLY the ACCOUNTS arm's scope hint; hold the
    // transactions arm CONSTANT (full) and the snapshot constant, so any
    // difference is attributable to the account payload alone. Expected after
    // W3: ZERO drift — the brief payload carries the DEBT_ONLY subset, which is
    // the exact row population the debt grade reads.
    if (acctsBrief && acctsFull) {
      const mkDebtCtx = (acctsSection: ContextDomainSection): SpaceContext_AI => {
        const base = contextWith(space.id, owner.userId, fullSection, { withSnapshot: true });
        return { ...base, domains: { ...base.domains, [FinanceDomains.ACCOUNTS]: acctsSection } };
      };
      const dBrief = debtConclusionsOf(mkDebtCtx(acctsBrief));
      const dFull  = debtConclusionsOf(mkDebtCtx(acctsFull));
      const dKeys = (Object.keys(dFull) as (keyof DebtConclusions)[]).filter((k) => dBrief[k] !== dFull[k]);
      if (dKeys.length > 0) {
        debtDrifting++;
        console.log(`\n  ⚠ DEBT drift on ${space.name} (${space.id}) — EXPECTED ZERO after W3:`);
        for (const k of dKeys) {
          console.log(`        ${String(k).padEnd(26)} brief=${String(dBrief[k]).padEnd(16)} full=${String(dFull[k])}`);
        }
      }
    }

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
  console.log(`  Spaces whose CONCLUSIONS move on the hint alone: ${drifting}` +
    (drifting === 0 ? "  ✓ (expected ZERO)" :
     "  ⚠ UNEXPECTED — the W4 invariant says this must be zero"));
  console.log(`  W3 DEBT parity — spaces whose DEBT conclusions move on the hint alone: ${debtDrifting}` +
    (debtDrifting === 0 ? "  ✓ (expected ZERO: the brief payload carries the debt rows)" :
     "  ⚠ UNEXPECTED — the W3 invariant says this must be zero"));
  console.log(
    `\n  W4 — the 30-vs-90-day window seam is REMOVED: the assessment window is\n` +
    `  90 rolling days at EVERY scope hint (lib/ai/assemblers/transactions.ts,\n` +
    `  ASSESSMENT_WINDOW_DAYS). scopeHint is transport-only. Expected drift is\n` +
    `  ZERO for every conclusion — there is no longer any "expected window-basis"\n` +
    `  attribution. Any Space printed above is a DEFECT to investigate, never a\n` +
    `  normalized exception.`,
  );
  console.log(`  Spaces where brief scope DROPS the Income category: ${incomeLostSpaces.length}` +
    (incomeLostSpaces.length ? `  (${incomeLostSpaces.join(", ")})` : ""));

  if (drifting > 0) {
    console.log(
      `\n  ⚠ W4 INVARIANT VIOLATED: same corpus + same day + different scopeHint\n` +
      `    must yield the same assessment conclusions. scopeHint is a transport\n` +
      `    knob, never a semantics knob. Investigate the rows above as a defect —\n` +
      `    do not reclassify them as expected.\n`,
    );
  } else {
    console.log(`\n  ✓ no conclusion moves on the hint alone — the W4 invariant holds.\n`);
  }
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => { console.error(err); await db.$disconnect(); process.exitCode = 1; });
