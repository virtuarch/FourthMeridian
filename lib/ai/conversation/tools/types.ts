/**
 * lib/ai/conversation/tools/types.ts
 *
 * THE TOOL CONTRACT — `ToolContext`, `ToolDefinition` and the `CashSpineReads`
 * seam every tool module is written against.
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

import type { AccountsSectionData, TransactionsSummaryData } from '@/lib/ai/types';
import type { IncomeTransactionReader, AccountTypeReader } from '@/lib/ai/forecast/streams';
import type { PlanSlot } from '../pending-plan';
import type { SpaceContext } from '@/lib/space';
import type { TurnEvidence } from '../memory-model';
// ⚠️ READING memory, never writing it. `recallMemories` is the store's read half;
// the write half lives in the turn loop (slice 7) and in `remember`. This file
// still holds no Prisma client, which a test asserts.
import type { MemoryClient } from '../memory-store';
/**
 * RLS-C-S3 — a TYPE-ONLY import. This file still holds no Prisma client (the
 * source scan in lib/ai/measures/measures.test.ts and its siblings depend on that),
 * and `import type` erases at compile, so the authority arrives on `ToolContext`
 * and nowhere else.
 */
import type { ReadClient } from '@/lib/db/tenant-context';
import type { AiPhaseRunner } from '@/lib/ai/tenant-phase';

// ── The tool contract ────────────────────────────────────────────────────────

/**
 * FM-AUDIT-010 — the authority reads the cash spine makes, as one seam.
 *
 * ⚠️ PRODUCTION LEAVES THIS UNSET, and the database authorities are used. It
 * exists so a CI test can drive the REAL scenario path — argument merging, the
 * derived floor, liability lines, income rules, the spine, the ledger, the solve —
 * on fixture DATA: the seam is the data boundary, and nothing downstream of it is
 * stubbed. The income page is still resolved by the real stream resolver; the
 * transactions summary is still whatever the real monthly fold produced.
 */
export interface CashSpineReads {
  incomeTransactions: IncomeTransactionReader;
  incomeAccountTypes: AccountTypeReader;
  accounts: () => Promise<AccountsSectionData | null>;
  transactionsSummary: () => Promise<TransactionsSummaryData | null>;
}

export interface ToolContext {
  spaceCtx: SpaceContext;
  spaceId:  string;
  /**
   * RLS slice A — THE DATABASE AUTHORITY MEMORY RUNS UNDER, and the only client
   * anything in the tool layer is given.
   *
   * ⚠️ REQUIRED, AND DELIBERATELY NOT DEFAULTED. This file holds no Prisma client
   * (a source scan asserts it), so a context that omitted this would have nothing
   * to fall back to — which is the point: every caller that opens a transcript
   * states the authority its memory reads and writes execute under, and
   * TypeScript names the ones that forget. It is narrowed to `spaceMemory`, so it
   * cannot be used to reach a financial table from here even by accident.
   */
  memoryClient: MemoryClient;
  /**
   * RLS-C-S3 — THE DATABASE AUTHORITY EVERY FINANCIAL READ IN THIS FILE RUNS
   * UNDER, stated by whoever opened the transcript.
   *
   * ⚠️ REQUIRED, AND DELIBERATELY NOT DEFAULTED, for the same reason
   * `memoryClient` is: this file holds no Prisma client of its own (a source scan
   * asserts it), so a context that omitted this would have nothing to fall back
   * on — and TypeScript names the callers that forget.
   *
   * ⚠️ IT IS THE MIGRATION PRINCIPAL TODAY, ON PURPOSE AND NOT BY OVERSIGHT. The
   * twenty tools below read ten tables, every one of which is granted to `fm_app`,
   * so an RLS refusal on this surface cannot fail loudly: it arrives as an EMPTY
   * SET, and this surface turns empty sets into declarative English for a model
   * ("no dated transactions are available for this Space"). Flipping the authority
   * before an absence contract exists would convert a refusal into a confident
   * false statement to the user. Separately, a chat turn makes up to six model
   * calls, so a tenant transaction cannot span one. The MECHANISM is in place; the
   * authority moves in a later slice. See docs/plans/RLS-SILENT-REFUSAL-CAS.md.
   *
   * Narrower than `memoryClient` in intent and wider in type: `ReadClient` has no
   * `$transaction`, so no tool can open a transaction of its own.
   */
  readClient: ReadClient;
  /**
   * RLS-AI-S2 — THE PHASE RUNNER, when the surface that opened this transcript has
   * an authenticated session to bind.
   *
   * ⚠️ OPTIONAL, AND THE OPTIONALITY IS THE MIGRATION PATH, NOT AN ESCAPE. Absent
   * means every read runs on `readClient` exactly as it did before this field
   * existed — which is what the dogfood harnesses and batch runners need, since
   * they read a CLONE as the migration principal and have no session at all. When
   * present, the DISPATCHER (`turn.ts`) opens one short tenant transaction per tool
   * call and hands the tool a context whose `readClient` and `memoryClient` are
   * that transaction. No tool body knows about it; that is the point.
   *
   * ⚠️ IT CARRIES AN IDENTITY AND A MODEL CANNOT REACH IT. There is no tool
   * argument, no JSON-schema field and no transcript channel through which this
   * could be set: it is constructed where the session is, from `requireUser()`.
   */
  phase?: AiPhaseRunner;
  /** Test seam only — see CashSpineReads. Unset in production. */
  cashSpineReads?: CashSpineReads;
  /**
   * FM-AUDIT-019 — durable memory writes (`remember`, the projection checkpoint)
   * happen ONLY when this is exactly `true`: the product chat route, or a harness
   * explicitly opted in against a clone (memory-write-policy.ts). Absent = no writes.
   */
  memoryWrites?: boolean;
  /** The clock for the whole run, so two tools can never disagree about today. */
  asOfISO:  string;
  /**
   * Who said what in this turn — set by the turn loop, read ONLY by `remember`'s
   * provenance gate. Optional and harness-safe: a context built without it still
   * runs every tool, and a memory write carrying money then fails closed. It is
   * never sent to the model and no financial tool reads it.
   */
  turn?:    TurnEvidence;
  /**
   * The conditions staged in this conversation and not yet run — written only by
   * `stage_assumptions`, read only by the scenario tools, which merge it into the
   * arguments they execute. Absent in a context built without it (every harness
   * that predates it): nothing is merged, and behaviour is exactly as before.
   */
  plan?:    PlanSlot;
}

export interface ToolDefinition {
  name:        string;
  description: string;
  /** JSON Schema for the arguments. Kept small — a model reads these every turn. */
  parameters:  Record<string, unknown>;
  run:         (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}
