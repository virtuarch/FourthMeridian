/**
 * lib/imports/claim.ts  (IDEMP-001 · SEC-007 · OPS-007)
 *
 * The import's IDEMPOTENCY KEY and its caps — the pure half of the fix for the
 * runtime-confirmed defect where one 6-row file submitted twice concurrently
 * produced 12 rows and a crash mid-loop left a PROCESSING batch nobody could
 * roll back.
 *
 *   · sha256 of the uploaded BYTES is the key (not the name: the same statement
 *     saved under two names is the same statement; two different statements
 *     with the same name are not).
 *   · The ImportBatch is CREATED BEFORE PARSING with that hash. The partial
 *     unique index ImportBatch_account_file_live_key (migration
 *     20261022000100) refuses a second live batch for the same account + file;
 *     Prisma surfaces that as P2002 and the claim reports the batch that
 *     already holds the slot, so the route answers 409 with its id.
 *   · ROLLED_BACK and FAILED batches are outside the index predicate, so a
 *     legitimate re-import after a rollback or a failure is not blocked.
 *   · A PROCESSING batch whose last write is older than the route's time
 *     budget is a dead lambda's, and becomes rollback-eligible
 *     (stalledImportCutoff) — the operator/user janitor for OPS-007.
 *   · Caps: bytes (before hashing), rows (after parsing), and the inflated
 *     size of an XLSX (lib/imports/zip-bounds.ts, before ExcelJS touches it).
 */

import { createHash } from "node:crypto";
import { ImportBatchStatus, type ImportSource, type Prisma } from "@prisma/client";

/** Upload byte cap. 10 MB is ~100k CSV rows — ten times the row cap. */
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
/** Row cap per batch (OPS-007: the import had none). */
export const IMPORT_MAX_ROWS = 10_000;
/** The route's declared maxDuration, in ms. */
export const IMPORT_BUDGET_MS = 300_000;
/** Slack past the budget before a PROCESSING batch is presumed dead. */
export const IMPORT_STALL_SLACK_MS = 60_000;
/** Rows written per tenant transaction on the fast path. */
export const IMPORT_CHUNK_ROWS = 200;

/** Statuses that HOLD the (account, file) slot — must mirror the index predicate. */
export const IMPORT_LIVE_STATUSES: readonly ImportBatchStatus[] = [
  ImportBatchStatus.PENDING,
  ImportBatchStatus.PROCESSING,
  ImportBatchStatus.COMPLETED,
  ImportBatchStatus.COMPLETED_WITH_ERRORS,
];

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Split rows into fixed-size chunks (the last one may be shorter). */
export function chunkRows<T>(rows: readonly T[], size: number = IMPORT_CHUNK_ROWS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** A PROCESSING/PENDING batch last touched before this instant is stalled. */
export function stalledImportCutoff(now: Date): Date {
  return new Date(now.getTime() - IMPORT_BUDGET_MS - IMPORT_STALL_SLACK_MS);
}

/**
 * The rollback claim predicate: the recorded eligible statuses, PLUS a
 * PENDING/PROCESSING batch that stalled (its lambda died past the budget).
 * Exported so the route and its test share one definition.
 */
export function rollbackClaimWhere(batchId: string, now: Date): Prisma.ImportBatchWhereInput {
  return {
    id: batchId,
    OR: [
      { status: { in: [ImportBatchStatus.COMPLETED, ImportBatchStatus.COMPLETED_WITH_ERRORS, ImportBatchStatus.FAILED] } },
      { status: { in: [ImportBatchStatus.PENDING, ImportBatchStatus.PROCESSING] }, updatedAt: { lt: stalledImportCutoff(now) } },
    ],
  };
}

// ── The claim ─────────────────────────────────────────────────────────────────

export interface ImportClaimInput {
  financialAccountId: string;
  createdByUserId: string;
  source: ImportSource;
  originalFilename: string | null;
  fileSha256: string;
}

export interface ImportClaimClient {
  importBatch: {
    create(args: { data: Prisma.ImportBatchUncheckedCreateInput; select: { id: true } }): Promise<{ id: string }>;
    findFirst(args: {
      where: Prisma.ImportBatchWhereInput;
      select: { id: true; status: true; createdAt: true };
    }): Promise<{ id: string; status: ImportBatchStatus; createdAt: Date } | null>;
  };
}

export type ImportClaimResult =
  | { ok: true; batchId: string }
  | { ok: false; reason: "duplicate" };

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/**
 * Create the batch row FIRST (status PENDING, no rows yet). The unique index
 * is the guard; this function only translates its refusal into a verdict the
 * route can answer with. Any other error propagates.
 */
export async function claimImportBatch(client: ImportClaimClient, input: ImportClaimInput): Promise<ImportClaimResult> {
  try {
    const row = await client.importBatch.create({
      data: {
        financialAccountId: input.financialAccountId,
        createdByUserId:    input.createdByUserId,
        source:             input.source,
        originalFilename:   input.originalFilename,
        fileSha256:         input.fileSha256,
        status:             ImportBatchStatus.PENDING,
      },
      select: { id: true },
    });
    return { ok: true, batchId: row.id };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // J-D6 — NO further statement here. On PostgreSQL a unique violation ABORTS the
    // surrounding transaction (25P02: every later statement fails), and the route
    // calls this inside withTenantDb, so a lookup at this point turned the
    // duplicate into a 500. The caller looks the winner up in a FRESH phase
    // (findLiveImportBatch).
    return { ok: false, reason: "duplicate" };
  }
}

/**
 * The live batch that holds an (account, file) slot — read in its OWN phase after
 * a lost claim (J-D6). Null when the winner has since rolled back or failed.
 */
export async function findLiveImportBatch(
  client: ImportClaimClient,
  slot: { financialAccountId: string; fileSha256: string },
): Promise<{ id: string; status: ImportBatchStatus; createdAt: Date } | null> {
  return client.importBatch.findFirst({
    where: {
      financialAccountId: slot.financialAccountId,
      fileSha256:         slot.fileSha256,
      status:             { in: [...IMPORT_LIVE_STATUSES] },
    },
    select: { id: true, status: true, createdAt: true },
  });
}
