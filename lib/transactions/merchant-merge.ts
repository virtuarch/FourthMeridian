/**
 * lib/transactions/merchant-merge.ts
 *
 * Merchant Intelligence — MI2 S1 merge core (extraction, no new behavior).
 *
 * The ONE place that collapses one or more duplicate Merchants onto a single
 * survivor. It is a byte-for-byte extraction of the ratified merge contract first
 * proven in scripts/merge-wgu-merchants.ts: the same atomic $transaction body,
 * the same operation order, the same safety posture. Nothing here is new
 * behavior — the WGU script's `main()` body is lifted into a client-injected,
 * console-free, argv-free library so a NON-console caller can invoke it too.
 *
 * ── Reuse boundary (why this has zero CLI logic) ─────────────────────────────
 * The engine takes already-resolved merchant IDs and returns a structured
 * `MergeReport` — it never parses flags, never prints, never reads `process`,
 * never imports the `db` singleton. Resolution (raw descriptor / canonicalKey →
 * id) and reporting belong to the caller. This is exactly the single-sourcing
 * pattern of merchant-write.ts: one contract, many callers —
 *   • scripts/merge-merchants.ts (the sanctioned CLI) today, and
 *   • a future MI2 S2 accept-endpoint, Platform Operations, and merge-suggestion
 *     acceptance — each passing its own client and its own resolved IDs,
 *     WITHOUT modifying this engine.
 *
 * ── Merge operations (identity columns only — never category/flow) ───────────
 * Per duplicate, inside one $transaction:
 *   1. Re-point aliases        (MerchantAlias.merchantId dup→survivor, source USER)
 *   2. Re-point transactions   (Transaction.merchantId dup→survivor — identity col ONLY)
 *   3. Move-or-fold rules       (existing survivor rule for same scope/owner ⇒ fold:
 *                                re-point categoryRuleId BEFORE deleting the dup rule;
 *                                else move the rule to the survivor)
 *   4. plaidEntityId transfer   (to survivor ONLY if survivor has none; else drop dup's)
 *   5. Delete the now-empty duplicate Merchant
 * NEVER touches raw Transaction.merchant, category, categorySource, flowType, or
 * pfc*. Atomic (a failure rolls the whole merge back). Idempotent (a re-run finds
 * no duplicates and reports nothing). No auto-merge: it writes only when a caller
 * explicitly passes survivor+duplicate IDs with `dryRun: false`.
 *
 * ── Zero db dependency ───────────────────────────────────────────────────────
 * Every @prisma/client import is TYPE-ONLY (erased at compile time). The client
 * is injected, so this module runs under a plain `npx tsx` against an in-memory
 * fake (its test) with no DB — mirroring merchant-write.ts / merchant-resolver.ts.
 */

import type { MerchantRuleScope, Prisma, PrismaClient } from "@prisma/client";

/**
 * The injected client. A `PrismaClient` (or anything structurally compatible)
 * satisfies this: the engine opens its own `$transaction` for the write phase,
 * exactly as the WGU script did with the `db` singleton.
 */
export type MergeEngineClient = PrismaClient;

/** Opaque provenance tag — which tier/signal justified the merge. Echoed, not persisted (S1). */
export interface MergeEvidence {
  tier?: string;
  signal?: string;
  note?: string;
}

/** What the engine is asked to merge. IDs are already resolved by the caller. */
export interface MergeInput {
  /** The Merchant that survives; receives all re-pointed aliases/transactions/rules. */
  survivorId: string;
  /** The Merchants absorbed into the survivor and then deleted. */
  duplicateIds: string[];
  /** Provenance tag for the caller's own logging/audit. Echoed into the report. */
  evidence?: MergeEvidence;
  /** When true (the DEFAULT), no writes occur — the report is a projection. */
  dryRun?: boolean;
}

/** Per-duplicate outcome (actual counts after apply; projected counts on dry-run). */
export interface DuplicateMergeResult {
  id: string;
  canonicalKey: string;
  displayName: string;
  aliasesRepointed: number;
  transactionsRepointed: number;
  rulesMoved: number;
  rulesFolded: number;
  plaidEntityTransferred: boolean;
  /** The dup's plaidEntityId discarded because the survivor already had one, else null. */
  plaidEntityDropped: string | null;
  deleted: boolean;
}

/** The structured result of a merge — the engine's only output (it never prints). */
export interface MergeReport {
  /** false on dry-run (nothing was written). */
  applied: boolean;
  survivor: { id: string; canonicalKey: string; displayName: string };
  perDuplicate: DuplicateMergeResult[];
  /**
   * Real measurement of the current DB state at report time. After an apply these
   * are the WGU success signal (duplicates gone → 0, no orphaned transactions →
   * 0). On dry-run they reflect the outstanding, not-yet-merged state.
   */
  verification: {
    duplicateMerchantsRemaining: number;
    transactionsOnOldIds: number;
    survivorAliasCount: number;
  };
  /** Non-fatal diagnostics (e.g. a requested duplicate id had no merchant row). */
  notes: string[];
  /** The caller's evidence tag, echoed back unchanged. */
  evidence?: MergeEvidence;
}

// ── Internal fetch shapes ─────────────────────────────────────────────────────

interface SurvivorRow {
  id: string;
  canonicalKey: string;
  displayName: string;
  plaidEntityId: string | null;
}

interface DuplicateRow {
  id: string;
  canonicalKey: string;
  displayName: string;
  plaidEntityId: string | null;
  aliases: { id: string; aliasKey: string }[];
  rules: { id: string; scope: MerchantRuleScope; ownerUserId: string | null; category: string }[];
  _count: { transactions: number };
}

/** Select shape for a duplicate — mirrors the WGU script's findMany select exactly. */
const DUPLICATE_SELECT = {
  id: true,
  canonicalKey: true,
  displayName: true,
  plaidEntityId: true,
  aliases: { select: { id: true, aliasKey: true } },
  rules: { select: { id: true, scope: true, ownerUserId: true, category: true } },
  _count: { select: { transactions: true } },
} as const;

/**
 * Decide, via a READ ONLY lookup, whether a duplicate's rule folds into an
 * existing survivor rule (same scope + owner) or moves to the survivor. Shared by
 * the dry-run projection and the apply path so the two never diverge.
 */
async function ruleDisposition(
  reader: Prisma.TransactionClient,
  survivorId: string,
  rule: DuplicateRow["rules"][number],
): Promise<{ kind: "fold"; conflictId: string } | { kind: "move" }> {
  const conflict = await reader.merchantRule.findFirst({
    where: { merchantId: survivorId, scope: rule.scope, ownerUserId: rule.ownerUserId },
    select: { id: true },
  });
  return conflict ? { kind: "fold", conflictId: conflict.id } : { kind: "move" };
}

/** Measure current DB state — identical code for dry-run and post-apply. */
async function measure(
  reader: Prisma.TransactionClient,
  survivorId: string,
  duplicateIds: string[],
): Promise<MergeReport["verification"]> {
  const [duplicateMerchantsRemaining, transactionsOnOldIds, survivorAliasCount] = await Promise.all([
    reader.merchant.count({ where: { id: { in: duplicateIds } } }),
    reader.transaction.count({ where: { merchantId: { in: duplicateIds } } }),
    reader.merchantAlias.count({ where: { merchantId: survivorId } }),
  ]);
  return { duplicateMerchantsRemaining, transactionsOnOldIds, survivorAliasCount };
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Merge one or more duplicate Merchants onto a survivor. Dry-run by default:
 * pass `dryRun: false` to write. Atomic on apply; a failure mid-merge rolls the
 * whole transaction back and re-throws (nothing partially merged).
 *
 * Guards (throw before any write):
 *   • survivor id resolves to no Merchant           → "survivor merchant not found"
 *   • duplicateIds is empty                          → "no duplicate ids supplied"
 *   • a duplicate id equals the survivor id          → "a duplicate id equals the survivor id"
 * A duplicate id with no Merchant row is NOT an error — it is noted and skipped
 * (mirrors the WGU script's "no merchant row for key" note; keeps re-runs safe).
 */
export async function mergeMerchants(
  client: MergeEngineClient,
  input: MergeInput,
): Promise<MergeReport> {
  const dryRun = input.dryRun ?? true;
  const { survivorId, duplicateIds, evidence } = input;
  const reader = client as unknown as Prisma.TransactionClient;

  // ── Guards ──────────────────────────────────────────────────────────────────
  if (duplicateIds.length === 0) {
    throw new Error("mergeMerchants: no duplicate ids supplied");
  }
  if (duplicateIds.includes(survivorId)) {
    throw new Error("mergeMerchants: a duplicate id equals the survivor id");
  }

  const survivorRow = (await reader.merchant.findUnique({
    where: { id: survivorId },
    select: { id: true, canonicalKey: true, displayName: true, plaidEntityId: true },
  })) as SurvivorRow | null;
  if (!survivorRow) {
    throw new Error(`mergeMerchants: survivor merchant not found (id=${survivorId})`);
  }

  const dups = (await reader.merchant.findMany({
    where: { id: { in: duplicateIds, not: survivorRow.id } },
    select: DUPLICATE_SELECT,
  })) as unknown as DuplicateRow[];

  const notes: string[] = [];
  const foundIds = new Set(dups.map((d) => d.id));
  for (const id of duplicateIds) {
    if (!foundIds.has(id)) notes.push(`no merchant row for id=${id} — skipping`);
  }

  const survivor = {
    id: survivorRow.id,
    canonicalKey: survivorRow.canonicalKey,
    displayName: survivorRow.displayName,
  };

  // ── Nothing to do (already merged / all skipped) ─────────────────────────────
  if (dups.length === 0) {
    return {
      applied: false,
      survivor,
      perDuplicate: [],
      verification: await measure(reader, survivorRow.id, duplicateIds),
      notes: notes.length ? notes : ["no duplicate merchants found — nothing to do"],
      evidence,
    };
  }

  // ── Dry-run: project counts via read-only lookups, write nothing ─────────────
  if (dryRun) {
    // Track a projected survivor plaidEntityId so transfer-if-empty projects
    // correctly across multiple duplicates (first dup with an id wins), exactly
    // as the apply path mutates it in order.
    let projectedSurvivorEntityId = survivorRow.plaidEntityId;
    const perDuplicate: DuplicateMergeResult[] = [];
    for (const dup of dups) {
      let rulesMoved = 0;
      let rulesFolded = 0;
      for (const rule of dup.rules) {
        const d = await ruleDisposition(reader, survivorRow.id, rule);
        if (d.kind === "fold") rulesFolded++;
        else rulesMoved++;
      }
      let plaidEntityTransferred = false;
      let plaidEntityDropped: string | null = null;
      if (dup.plaidEntityId && !projectedSurvivorEntityId) {
        plaidEntityTransferred = true;
        projectedSurvivorEntityId = dup.plaidEntityId;
      } else if (dup.plaidEntityId) {
        plaidEntityDropped = dup.plaidEntityId;
      }
      perDuplicate.push({
        id: dup.id,
        canonicalKey: dup.canonicalKey,
        displayName: dup.displayName,
        aliasesRepointed: dup.aliases.length,
        transactionsRepointed: dup._count.transactions,
        rulesMoved,
        rulesFolded,
        plaidEntityTransferred,
        plaidEntityDropped,
        deleted: false,
      });
    }
    return {
      applied: false,
      survivor,
      perDuplicate,
      verification: await measure(reader, survivorRow.id, duplicateIds),
      notes,
      evidence,
    };
  }

  // ── Apply: the WGU $transaction body, verbatim in operation and order ────────
  // `survivorPlaidEntityId` mirrors the WGU script's local mutation of
  // `survivor.plaidEntityId` as duplicates are processed in order.
  let survivorPlaidEntityId = survivorRow.plaidEntityId;
  const perDuplicate: DuplicateMergeResult[] = [];

  await client.$transaction(async (tx) => {
    for (const dup of dups) {
      // 1) Re-point aliases (M5 pointAlias semantics: explicit teach → USER source).
      const aliases = await tx.merchantAlias.updateMany({
        where: { merchantId: dup.id },
        data: { merchantId: survivorRow.id, source: "USER" },
      });

      // 2) Re-point historical transactions — merchant identity column ONLY.
      const rows = await tx.transaction.updateMany({
        where: { merchantId: dup.id },
        data: { merchantId: survivorRow.id },
      });

      // 3) Rules: move, or fold into an existing survivor rule for the same owner/scope.
      let rulesMoved = 0;
      let rulesFolded = 0;
      for (const rule of dup.rules) {
        const disposition = await ruleDisposition(tx, survivorRow.id, rule);
        if (disposition.kind === "fold") {
          // Re-point provenance links BEFORE deleting the dup rule (never SetNull).
          await tx.transaction.updateMany({
            where: { categoryRuleId: rule.id },
            data: { categoryRuleId: disposition.conflictId },
          });
          await tx.merchantRule.delete({ where: { id: rule.id } });
          rulesFolded++;
        } else {
          await tx.merchantRule.update({
            where: { id: rule.id },
            data: { merchantId: survivorRow.id },
          });
          rulesMoved++;
        }
      }

      // 4) plaidEntityId: transfer to survivor only if survivor has none (unique col).
      let plaidEntityTransferred = false;
      let plaidEntityDropped: string | null = null;
      if (dup.plaidEntityId && !survivorPlaidEntityId) {
        await tx.merchant.update({ where: { id: dup.id }, data: { plaidEntityId: null } });
        await tx.merchant.update({
          where: { id: survivorRow.id },
          data: { plaidEntityId: dup.plaidEntityId },
        });
        survivorPlaidEntityId = dup.plaidEntityId;
        plaidEntityTransferred = true;
      } else if (dup.plaidEntityId) {
        plaidEntityDropped = dup.plaidEntityId;
      }

      // 5) Delete the now-empty duplicate (no aliases/rules/transactions reference it).
      await tx.merchant.delete({ where: { id: dup.id } });

      perDuplicate.push({
        id: dup.id,
        canonicalKey: dup.canonicalKey,
        displayName: dup.displayName,
        aliasesRepointed: aliases.count,
        transactionsRepointed: rows.count,
        rulesMoved,
        rulesFolded,
        plaidEntityTransferred,
        plaidEntityDropped,
        deleted: true,
      });
    }
  });

  return {
    applied: true,
    survivor,
    perDuplicate,
    verification: await measure(reader, survivorRow.id, duplicateIds),
    notes,
    evidence,
  };
}
