/**
 * lib/transactions/transfer-debt-payment-correction-write.ts
 *
 * v2.7-P1 — the IMPURE half of the transfer authority's debt-payment correction:
 * gather candidates, ask the canonical transfer authority for its verdict, apply
 * the pure rule (transfer-debt-payment-correction.ts), and write.
 *
 * Two callers, ONE planner:
 *   · lib/plaid/syncTransactions.ts — after every completed sync, over the rows
 *     that sync touched (plus this rule's own unresolved rows nearby, which a
 *     newly-arrived far leg may now settle). Best-effort: a failure here never
 *     fails the sync, and leaves the row as classifier output, whose money
 *     totals are already right.
 *   · scripts/repair-transfer-debt-payment.ts — the historical repair, dry-run by
 *     default.
 *
 * ── The evidence ────────────────────────────────────────────────────────────
 *
 * `resolveTransferAssessments` — the SAME entry point every list read, the AI
 * assembler and the detail drawer use. Not a re-implementation: the mutual-
 * uniqueness guard against same-amount coincidences, the cash veto, admission,
 * the identifier tier and the cross-owner detection are all its own.
 *
 * Its KD-15 gate strips counterparty ACCOUNT IDS a Space may not see and leaves
 * the evidence level and maturity intact. This writer persists no counterparty,
 * so it hands the resolver a sentinel Space that matches nothing: every id is
 * stripped (fail closed), and only the level + maturity — the two inputs the
 * rule reads — survive.
 *
 * ── FLOW-CLASSIFIER-EXCEPTION (transfer-authority) ──────────────────────────
 *
 * This module writes `flowType` WITHOUT the classifier, on purpose, and is an
 * approved exception in lib/transactions/flow-classifier-authority.test.ts. The
 * classifier is context-free and cannot see the other leg; this writer exists
 * precisely to record the verdict of the authority that can. It stamps
 * `flowAuthority = TRANSFER_AUTHORITY` (and nulls the classifier version via
 * foreignFlowOwnershipFields), so the row never claims to be classifier output.
 *
 * ── The write ───────────────────────────────────────────────────────────────
 *
 * One `$transaction`, one guarded `updateMany` per row. The guard re-states the
 * row's BEFORE shape (flowType, flowAuthority, classificationReason, category,
 * live, not a human category), so a row that changed between plan and write —
 * a concurrent sync, a user override — is left alone and reported as a
 * conflict, and a second run finds nothing to do.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { resolveTransferAssessments, type TransferResolutionRow } from "@/lib/transactions/transfer-resolution";
import type { TransferCandidateRelationship } from "@/lib/transactions/RelationshipResolver";
import { assertMayWriteFlow, foreignFlowOwnershipFields, type FlowAuthorityName } from "@/lib/transactions/flow-authority";
import {
  CORRECTION_SHAPES,
  DEPOSITORY_ACCOUNT_TYPES,
  LOAN_PAYMENTS_FAMILY,
  USER_CATEGORY_SOURCES,
  decideTransferDebtPaymentCorrection,
  type CorrectionDecision,
  type CorrectionKind,
  type CorrectionSkipCode,
} from "@/lib/transactions/transfer-debt-payment-correction";
import { TRANSFER_MATCH_WINDOW_DAYS } from "@/lib/transactions/transfer-maturation";

/** A Space id no link can carry — makes the resolver's KD-15 gate strip every id. */
export const WRITE_GATE_SPACE_ID = "__transfer-authority-write__";

/** The authority this writer IS, and the one authority it declares it displaces. */
const WRITER: FlowAuthorityName = "TRANSFER_AUTHORITY";
const CLAIMS: readonly FlowAuthorityName[] = ["CLASSIFIER"];

const DAY_MS = 86_400_000;
/** How far either side of a sync's touched rows this rule re-opens its own unresolved rows. */
const REOPEN_PAD_MS = (TRANSFER_MATCH_WINDOW_DAYS + 2) * DAY_MS;
const ID_CHUNK = 5000;

/** The narrow client surface this module needs — satisfied by `db` and by a test fake. */
export type CorrectionClient = Pick<PrismaClient, "transaction" | "financialAccount" | "spaceAccountLink" | "$transaction">;

/** The columns a candidate needs: the resolver's leg shape + the rule's inputs. */
export const CANDIDATE_SELECT = {
  id: true, financialAccountId: true, date: true, amount: true, currency: true,
  flowType: true, deletedAt: true, pending: true, settlementState: true,
  pfcDetailed: true, pfcPrimary: true, merchant: true, category: true,
  counterpartyType: true, description: true, economicDate: true,
  counterpartyAccountId: true,
  flowAuthority: true, categorySource: true,
  classificationReason: true, classificationConfidence: true,
  plaidTransactionId: true,
} as const satisfies Prisma.TransactionSelect;

export interface CandidateRow {
  id: string;
  financialAccountId: string | null;
  date: Date;
  amount: number;
  currency: string | null;
  flowType: string | null;
  deletedAt: Date | null;
  pending: boolean;
  settlementState: string | null;
  pfcDetailed: string | null;
  pfcPrimary: string | null;
  merchant: string | null;
  category: string | null;
  counterpartyType: string | null;
  description: string | null;
  economicDate: Date | null;
  counterpartyAccountId: string | null;
  flowAuthority: string | null;
  categorySource: string | null;
  classificationReason: string | null;
  classificationConfidence: number | null;
  plaidTransactionId: string | null;
}

/** One planned write — everything the applier and the audit report need. */
export interface PlannedCorrection {
  row: CandidateRow;
  ownAccountType: string;
  kind: CorrectionKind;
  arm: "A" | "B";
  evidenceLevel: string;
  maturity: string;
  before: { flowType: string | null; category: string | null; classificationReason: string | null; classificationConfidence: number | null; flowAuthority: string | null };
  after: (typeof CORRECTION_SHAPES)[CorrectionKind];
}

export interface CorrectionPlan {
  scanned: number;
  writes: PlannedCorrection[];
  /** Candidates left untouched, by reason. KEEP and SKIP both land here. */
  untouched: Partial<Record<CorrectionSkipCode, number>>;
  /** Pending rows left to retire because their posted twin is live. */
  retiringPending: CandidateRow[];
}

/** The Prisma `where` for both eligibility arms, on the given depository accounts. */
export function candidateWhere(depositoryAccountIds: readonly string[], extra: Prisma.TransactionWhereInput = {}): Prisma.TransactionWhereInput {
  const own = CORRECTION_SHAPES.TRANSFER_UNRESOLVED;
  return {
    AND: [
      { deletedAt: null, financialAccountId: { in: [...depositoryAccountIds] } },
      {
        OR: [
          // (A) classifier DEBT_PAYMENT from provider evidence.
          { flowType: "DEBT_PAYMENT", flowAuthority: "CLASSIFIER",
            OR: [{ pfcPrimary: LOAN_PAYMENTS_FAMILY }, { category: "Payment" }] },
          // (B) this rule's own low-confidence write.
          { flowType: "TRANSFER", flowAuthority: "TRANSFER_AUTHORITY",
            classificationReason: own.classificationReason, classificationConfidence: own.classificationConfidence,
            category: own.category, pfcPrimary: LOAN_PAYMENTS_FAMILY },
        ],
      },
      extra,
    ],
  } as Prisma.TransactionWhereInput;
}

/**
 * Plan corrections for a candidate set. Reads only; writes nothing.
 *
 * `candidates` may be any superset — the pure rule decides every row — but the
 * resolver call is only as cheap as the set is small, so callers pre-select with
 * `candidateWhere`.
 */
export async function planTransferDebtPaymentCorrections(
  client: CorrectionClient,
  candidates: readonly CandidateRow[],
): Promise<CorrectionPlan> {
  const plan: CorrectionPlan = { scanned: candidates.length, writes: [], untouched: {}, retiringPending: [] };
  if (candidates.length === 0) return plan;

  // Account types — own accounts AND persisted counterparties, one read.
  const accountIds = [...new Set(candidates.flatMap((c) =>
    [c.financialAccountId, c.counterpartyAccountId].filter((x): x is string => x != null)))];
  const accounts = await client.financialAccount.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, type: true },
  });
  const typeOf = new Map(accounts.map((a) => [a.id, a.type as string]));

  // Pending → posted supersession. A live pending row whose provider id is the
  // pendingTransactionRef of a LIVE row has posted: the posted row is the one
  // corrected; the pending one is left to retire, never rewritten.
  const pendingRefs = candidates.filter((c) => c.pending && c.plaidTransactionId).map((c) => c.plaidTransactionId as string);
  const postedRefs = new Set<string>();
  if (pendingRefs.length > 0) {
    const successors = await client.transaction.findMany({
      where: { pendingTransactionRef: { in: pendingRefs }, deletedAt: null, pending: false },
      select: { pendingTransactionRef: true },
    });
    for (const s of successors) if (s.pendingTransactionRef) postedRefs.add(s.pendingTransactionRef);
  }

  // The transfer authority's verdict. Rows carrying a persisted counterparty are
  // not re-assessed by the resolver (persisted links win), and the rule reads
  // their counterparty TYPE instead.
  // Only depository rows can be written, so only they are worth the resolver.
  const toAssess = candidates.filter((c) =>
    c.counterpartyAccountId == null && !c.deletedAt
    && c.financialAccountId != null && DEPOSITORY_ACCOUNT_TYPES.has(typeOf.get(c.financialAccountId) ?? ""));
  // ⚠️ ONE CALL PER CALENDAR MONTH of targets. The resolver gathers candidate
  // legs over the UNION window of its targets, capped at 5,000 rows; a two-year
  // historical repair in one call could hit that cap and silently starve the
  // match. Grouping by month changes no answer — the resolver pads its gather
  // window by the match window either side, so every rival leg of a target near
  // a month boundary is still loaded — it only keeps each window small.
  const byMonth = new Map<string, CandidateRow[]>();
  for (const c of toAssess) {
    const k = (c.economicDate ?? c.date).toISOString().slice(0, 7);
    const g = byMonth.get(k);
    if (g) g.push(c); else byMonth.set(k, [c]);
  }
  const assessments = new Map<string, TransferCandidateRelationship>();
  for (const group of byMonth.values()) {
    const part = await resolveTransferAssessments(client as never, group as unknown as TransferResolutionRow[], { spaceId: WRITE_GATE_SPACE_ID });
    for (const [id, a] of part) assessments.set(id, a);
  }

  for (const c of candidates) {
    const ownAccountType = c.financialAccountId ? typeOf.get(c.financialAccountId) ?? null : null;
    const a = assessments.get(c.id);
    const supersededByPosted = c.pending && c.plaidTransactionId != null && postedRefs.has(c.plaidTransactionId);
    const decision: CorrectionDecision = decideTransferDebtPaymentCorrection({
      ownAccountType,
      flowType: c.flowType,
      flowAuthority: c.flowAuthority,
      rowCategorySource: c.categorySource,
      category: c.category,
      pfcPrimary: c.pfcPrimary,
      pfcDetailed: c.pfcDetailed,
      classificationReason: c.classificationReason,
      classificationConfidence: c.classificationConfidence,
      deleted: c.deletedAt != null,
      supersededByPosted,
      persistedCounterpartyAccountType: c.counterpartyAccountId == null
        ? null
        : typeOf.get(c.counterpartyAccountId) ?? "unknown",
      assessment: a ? { evidenceLevel: a.evidenceLevel, maturity: a.maturity, unresolvedReason: a.unresolvedReason ?? null } : null,
    });
    if (decision.action === "WRITE") {
      plan.writes.push({
        row: c,
        ownAccountType: ownAccountType as string,
        kind: decision.kind,
        arm: decision.arm,
        evidenceLevel: decision.evidenceLevel,
        maturity: decision.maturity,
        before: {
          flowType: c.flowType, category: c.category,
          classificationReason: c.classificationReason,
          classificationConfidence: c.classificationConfidence,
          flowAuthority: c.flowAuthority,
        },
        after: decision.write,
      });
    } else {
      plan.untouched[decision.code] = (plan.untouched[decision.code] ?? 0) + 1;
      if (decision.code === "PENDING_SUPERSEDED") plan.retiringPending.push(c);
    }
  }
  return plan;
}

export interface CorrectionApplyResult {
  written: number;
  /** Planned rows whose BEFORE shape no longer held at write time. Left alone. */
  conflicts: string[];
}

/** The data written for one planned correction. Exported for the audit report and tests. */
export function correctionWriteData(p: PlannedCorrection): Prisma.TransactionUpdateManyMutationInput {
  return {
    flowType:                 p.after.flowType,
    category:                 p.after.category,
    classificationReason:     p.after.classificationReason,
    classificationConfidence: p.after.classificationConfidence,
    // categorySource is deliberately NOT written: it belongs to the merchant-
    // intelligence stack (merchant-schema.test.ts confines its stamping), and the
    // authorship of THIS decision is recorded where it belongs — flowAuthority.
    ...foreignFlowOwnershipFields("TRANSFER_AUTHORITY"),
  } as Prisma.TransactionUpdateManyMutationInput;
}

/**
 * Apply a plan. ONE database transaction; each row's write is guarded by its own
 * BEFORE shape, so the call is idempotent and never overwrites a concurrent
 * change or a human's category.
 */
export async function applyTransferDebtPaymentCorrections(
  client: CorrectionClient,
  writes: readonly PlannedCorrection[],
): Promise<CorrectionApplyResult> {
  if (writes.length === 0) return { written: 0, conflicts: [] };
  for (const p of writes) {
    // The ownership model, consulted at the write site: (A) displaces the
    // classifier under a DECLARED claim; (B) refreshes this authority's own row.
    assertMayWriteFlow(p.before.flowAuthority as FlowAuthorityName | null, WRITER, "transfer-debt-payment-correction", CLAIMS);
  }
  const ops = writes.map((p) => client.transaction.updateMany({
    where: {
      id: p.row.id,
      deletedAt: null,
      flowType: p.before.flowType as never,
      flowAuthority: p.before.flowAuthority as never,
      classificationReason: p.before.classificationReason as never,
      category: p.before.category as never,
      OR: [{ categorySource: null }, { categorySource: { notIn: [...USER_CATEGORY_SOURCES] as never } }],
    },
    data: correctionWriteData(p),
  }));
  const results = await client.$transaction(ops as never) as unknown as { count: number }[];
  const conflicts = writes.filter((_, i) => (results[i]?.count ?? 0) !== 1).map((p) => p.row.id);
  return { written: results.reduce((n, r) => n + (r?.count ?? 0), 0), conflicts };
}

/** Load candidate rows matching a where, paged by id. */
export async function loadCorrectionCandidates(
  client: CorrectionClient,
  where: Prisma.TransactionWhereInput,
): Promise<CandidateRow[]> {
  const out: CandidateRow[] = [];
  let lastId = "";
  for (;;) {
    const page = await client.transaction.findMany({
      where: lastId ? { AND: [where, { id: { gt: lastId } }] } : where,
      orderBy: { id: "asc" },
      take: ID_CHUNK,
      select: CANDIDATE_SELECT,
    }) as unknown as CandidateRow[];
    out.push(...page);
    if (page.length < ID_CHUNK) break;
    lastId = page[page.length - 1].id;
  }
  return out;
}

export interface SyncCorrectionResult {
  planned: number;
  written: number;
  conflicts: number;
}

/**
 * The sync-time seam. Corrects the rows one completed sync touched, and re-opens
 * this rule's own unresolved rows nearby (a far leg that just arrived — on this
 * Item or another — may now settle them).
 *
 * ⚠️ Scoped to the touched rows, never the corpus: every genuine card payment's
 * cash leg is an arm-(A) row that the rule KEEPS, and re-assessing all of them on
 * every sync would be unbounded work that can only ever answer "keep". The
 * historical backlog is the repair script's job.
 */
export async function correctTransferDebtPaymentsAfterSync(
  client: CorrectionClient,
  touchedTransactionIds: readonly string[],
): Promise<SyncCorrectionResult> {
  const ids = [...new Set(touchedTransactionIds)];
  if (ids.length === 0) return { planned: 0, written: 0, conflicts: 0 };

  // Arm (A) among the touched rows — the cheap, selective read first. Most syncs
  // end here with nothing to do.
  const touchedArmA: CandidateRow[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const rows = await client.transaction.findMany({
      where: { id: { in: chunk }, deletedAt: null, flowType: "DEBT_PAYMENT", flowAuthority: "CLASSIFIER",
               OR: [{ pfcPrimary: LOAN_PAYMENTS_FAMILY }, { category: "Payment" }] } as Prisma.TransactionWhereInput,
      select: CANDIDATE_SELECT,
    }) as unknown as CandidateRow[];
    touchedArmA.push(...rows);
  }

  // Arm (B) near the touched rows, on the same owners' depository accounts.
  const touchedMeta: { financialAccountId: string | null; date: Date }[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    touchedMeta.push(...await client.transaction.findMany({
      where: { id: { in: chunk } }, select: { financialAccountId: true, date: true },
    }));
  }
  const touchedAccountIds = [...new Set(touchedMeta.map((t) => t.financialAccountId).filter((x): x is string => x != null))];
  let reopened: CandidateRow[] = [];
  if (touchedAccountIds.length > 0 && touchedMeta.length > 0) {
    const owners = await client.financialAccount.findMany({
      where: { id: { in: touchedAccountIds } }, select: { ownerUserId: true },
    });
    const ownerIds = [...new Set(owners.map((o) => o.ownerUserId).filter((x): x is string => x != null))];
    if (ownerIds.length > 0) {
      const dep = await client.financialAccount.findMany({
        where: { ownerUserId: { in: ownerIds }, deletedAt: null, type: { in: [...DEPOSITORY_ACCOUNT_TYPES] as never } },
        select: { id: true },
      });
      const times = touchedMeta.map((t) => t.date.getTime());
      const own = CORRECTION_SHAPES.TRANSFER_UNRESOLVED;
      if (dep.length > 0) {
        reopened = await loadCorrectionCandidates(client, {
          deletedAt: null,
          financialAccountId: { in: dep.map((d) => d.id) },
          flowType: "TRANSFER", flowAuthority: "TRANSFER_AUTHORITY",
          classificationReason: own.classificationReason, classificationConfidence: own.classificationConfidence,
          category: own.category, pfcPrimary: LOAN_PAYMENTS_FAMILY,
          date: { gte: new Date(Math.min(...times) - REOPEN_PAD_MS), lte: new Date(Math.max(...times) + REOPEN_PAD_MS) },
        } as Prisma.TransactionWhereInput);
      }
    }
  }

  const byId = new Map<string, CandidateRow>();
  for (const r of [...touchedArmA, ...reopened]) byId.set(r.id, r);
  if (byId.size === 0) return { planned: 0, written: 0, conflicts: 0 };

  const plan = await planTransferDebtPaymentCorrections(client, [...byId.values()]);
  const applied = await applyTransferDebtPaymentCorrections(client, plan.writes);
  return { planned: plan.writes.length, written: applied.written, conflicts: applied.conflicts.length };
}
