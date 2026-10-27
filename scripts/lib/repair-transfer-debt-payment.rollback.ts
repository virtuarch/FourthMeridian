/**
 * scripts/lib/repair-transfer-debt-payment.rollback.ts
 *
 * v2.7-P1 — ROLLBACK for scripts/repair-transfer-debt-payment.ts. Client-injected
 * and pure apart from the client, so it runs against the in-memory fake in tests.
 *
 *   npx tsx … scripts/repair-transfer-debt-payment.ts --rollback=<report>.restore.json [--apply …]
 *
 * ── What it restores ────────────────────────────────────────────────────────
 *
 * The restore file (written by the repair BEFORE its first write) holds, per row,
 * the raw id and the BEFORE and AFTER values of every column the repair writes:
 * flowType · category · flowAuthority · classifierVersion · classificationReason ·
 * classificationConfidence. Nothing else was written (categorySource, amount,
 * date, flowDirection, counterpartyAccountId, pending, deletedAt, PFC columns are
 * never touched by the repair), so nothing else needs restoring.
 * `needsClassification` is DERIVED at read time (lib/transactions/needs-
 * classification.ts) and follows the restored columns automatically.
 *
 * ── Guard: only rows STILL in the repaired state ────────────────────────────
 *
 * Each row is reverted by a `updateMany` guarded on its full AFTER shape (all six
 * columns) AND "not a human category". A row that has moved on since the repair
 * — a later sync-time correction, a user override, a reclassification — is
 * reported (DRIFTED / USER_CATEGORY / MISSING) and left exactly as it is.
 *
 * Dry run by default. Apply is ONE interactive transaction and all-or-nothing
 * over the rows the plan found revertible: a guard miss at write time rolls the
 * whole rollback back (ABORTED_CONFLICT). `--expect` (mandatory in Production)
 * must equal the revertible count or nothing is written.
 *
 * ⚠️ A rollback restores DATA, not behaviour: while v2.7 code runs, the sync-time
 * transfer-authority pass re-corrects any reverted row the provider re-delivers.
 * Reverting behaviour is a code rollback (see the runbook).
 */

import type { PrismaClient } from "@prisma/client";
import { assertMayWriteFlow, isFlowAuthority, type FlowAuthorityName } from "@/lib/transactions/flow-authority";
import { CORRECTION_SHAPES, USER_CATEGORY_SOURCES } from "@/lib/transactions/transfer-debt-payment-correction";
import {
  REPAIR_RULE,
  RESTORABLE_COLUMNS,
  hashId,
  restoreChecksum,
  type RepairContext,
  type RestorableColumns,
  type RestoreFile,
  type RestoreRow,
} from "./repair-transfer-debt-payment.core";

export type RollbackClient = Pick<PrismaClient, "transaction" | "$transaction">;

export type RollbackRowState = "REVERTIBLE" | "DRIFTED" | "USER_CATEGORY" | "MISSING";
export type RollbackOutcome = "DRY_RUN" | "NOTHING_TO_DO" | "APPLIED" | "REFUSED_EXPECT_MISMATCH" | "ABORTED_CONFLICT";

export interface RollbackReport {
  rule: string;
  generatedAt: string;
  mode: "DRY_RUN" | "APPLY";
  outcome: RollbackOutcome;
  context: RepairContext;
  source: { generatedAt: string; state: RestoreFile["state"]; rows: number; checksum: string };
  expect: { count: number; matched: boolean } | null;
  totals: { inFile: number; revertible: number; reverted: number; drifted: number; userCategory: number; missing: number; tombstoned: number; conflicts: number };
  rows: { idHash: string; state: RollbackRowState; tombstoned: boolean; restoreTo: RestorableColumns }[];
  conflictIdHashes: string[];
}

export interface RollbackOptions {
  apply: boolean;
  now?: () => Date;
  expect?: number | null;
  /** The CURRENT run's gate facts; `targetHash` must match the file's when both are known. */
  context: RepairContext;
}

/** Thrown for a restore file that cannot be trusted. Messages carry no raw id. */
export class RestoreFileError extends Error {}

const ROLLBACK_SELECT = {
  id: true, deletedAt: true, categorySource: true,
  flowType: true, category: true, flowAuthority: true, classifierVersion: true,
  classificationReason: true, classificationConfidence: true,
} as const;

const AFTER_SHAPES = Object.values(CORRECTION_SHAPES);

function isRestorable(v: unknown): v is RestorableColumns {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const strOrNull = (x: unknown) => x === null || typeof x === "string";
  const numOrNull = (x: unknown) => x === null || (typeof x === "number" && Number.isFinite(x));
  return RESTORABLE_COLUMNS.every((k) => k in o)
    && strOrNull(o.flowType) && strOrNull(o.category) && strOrNull(o.flowAuthority)
    && strOrNull(o.classificationReason) && numOrNull(o.classifierVersion) && numOrNull(o.classificationConfidence);
}

/**
 * Parse and VERIFY a restore file: shape, version, rule, checksum, id ↔ idHash,
 * and that every AFTER is one of the repair's own written shapes. Throws
 * RestoreFileError on anything it cannot vouch for.
 */
export function parseRestoreFile(raw: unknown): RestoreFile {
  const f = raw as Partial<RestoreFile> | null;
  if (!f || f.kind !== "fm.repair-transfer-debt-payment.restore" || f.version !== 1) {
    throw new RestoreFileError("not a repair-transfer-debt-payment restore file (kind/version).");
  }
  if (f.rule !== REPAIR_RULE) throw new RestoreFileError("restore file was written by a different rule.");
  if (!Array.isArray(f.rows) || typeof f.checksum !== "string") throw new RestoreFileError("restore file has no rows/checksum.");
  if (restoreChecksum(f.rows) !== f.checksum) throw new RestoreFileError("restore file checksum mismatch — truncated or edited; refusing.");
  if (f.state !== "PLANNED" && f.state !== "APPLIED" && f.state !== "ABORTED") throw new RestoreFileError("restore file has an unknown state.");
  const seen = new Set<string>();
  f.rows.forEach((r: RestoreRow, i: number) => {
    if (!r || typeof r.id !== "string" || r.id === "" || r.idHash !== hashId(r.id)) {
      throw new RestoreFileError(`row ${i}: id does not match its idHash.`);
    }
    if (seen.has(r.id)) throw new RestoreFileError(`row ${i}: duplicate id.`);
    seen.add(r.id);
    if (!isRestorable(r.before) || !isRestorable(r.after)) throw new RestoreFileError(`row ${i} (${r.idHash}): before/after incomplete.`);
    const a = r.after;
    const isOwnShape = a.flowAuthority === "TRANSFER_AUTHORITY" && a.classifierVersion === null
      && AFTER_SHAPES.some((s) => s.flowType === a.flowType && s.category === a.category
        && s.classificationReason === a.classificationReason && s.classificationConfidence === a.classificationConfidence);
    if (!isOwnShape) throw new RestoreFileError(`row ${i} (${r.idHash}): AFTER is not a shape this repair writes.`);
    if (!isFlowAuthority(r.before.flowAuthority) || r.before.flowType == null) {
      throw new RestoreFileError(`row ${i} (${r.idHash}): BEFORE has no flow owner — not a row this repair could have written.`);
    }
  });
  return f as RestoreFile;
}

/** The six-column equality guard + live-or-not + not-human. */
function afterGuard(r: RestoreRow): Record<string, unknown> {
  return {
    id: r.id,
    flowType: r.after.flowType,
    category: r.after.category,
    flowAuthority: r.after.flowAuthority,
    classifierVersion: r.after.classifierVersion,
    classificationReason: r.after.classificationReason,
    classificationConfidence: r.after.classificationConfidence,
    OR: [{ categorySource: null }, { categorySource: { notIn: [...USER_CATEGORY_SOURCES] } }],
  };
}

const sameColumns = (row: Record<string, unknown>, c: RestorableColumns) =>
  RESTORABLE_COLUMNS.every((k) => (row[k] ?? null) === c[k]);

class RollbackConflict extends Error {
  constructor(readonly ids: string[]) { super(`rollback aborted: ${ids.length} row(s) changed since planning`); }
}

export async function runTransferDebtPaymentRollback(
  client: RollbackClient,
  restore: RestoreFile,
  opts: RollbackOptions,
): Promise<RollbackReport> {
  const now = opts.now ?? (() => new Date());
  if (restore.state === "ABORTED") {
    throw new RestoreFileError("the repair this file records ABORTED and wrote nothing — there is nothing to roll back.");
  }
  if (restore.context.targetHash && opts.context.targetHash && restore.context.targetHash !== opts.context.targetHash) {
    throw new RestoreFileError("this restore file belongs to a DIFFERENT database than the current target — refusing.");
  }
  if (opts.apply) {
    if (!opts.context.targetHash || !restore.context.targetHash) {
      throw new RestoreFileError("apply needs both the file's and the current target identity to prove they are the same database.");
    }
    if (restore.context.env !== opts.context.env) {
      throw new RestoreFileError(`restore file was written for env=${restore.context.env ?? "unknown"}, not env=${opts.context.env ?? "unknown"}.`);
    }
  }

  const ids = restore.rows.map((r) => r.id);
  const current = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 1000) {
    const page = await client.transaction.findMany({ where: { id: { in: ids.slice(i, i + 1000) } }, select: ROLLBACK_SELECT });
    for (const row of page as unknown as Record<string, unknown>[]) current.set(row.id as string, row);
  }

  const rows = restore.rows.map((r) => {
    const cur = current.get(r.id);
    let state: RollbackRowState;
    if (!cur) state = "MISSING";
    else if (cur.categorySource != null && USER_CATEGORY_SOURCES.has(cur.categorySource as string)) state = "USER_CATEGORY";
    else if (!sameColumns(cur, r.after)) state = "DRIFTED";
    else state = "REVERTIBLE";
    return { r, state, tombstoned: cur?.deletedAt != null };
  });
  const revertible = rows.filter((x) => x.state === "REVERTIBLE");
  const expect = opts.expect == null ? null : { count: opts.expect, matched: opts.expect === revertible.length };

  let outcome: RollbackOutcome = opts.apply ? "NOTHING_TO_DO" : "DRY_RUN";
  let reverted = 0;
  let conflictIds: string[] = [];
  if (opts.apply && expect && !expect.matched) {
    outcome = "REFUSED_EXPECT_MISMATCH";
  } else if (opts.apply && revertible.length > 0) {
    for (const { r } of revertible) {
      // Restoring the prior owner displaces the transfer authority — declared.
      assertMayWriteFlow(r.after.flowAuthority as FlowAuthorityName, r.before.flowAuthority as FlowAuthorityName,
        "repair-transfer-debt-payment rollback", ["TRANSFER_AUTHORITY"]);
    }
    try {
      reverted = await (client.$transaction as unknown as (fn: (tx: RollbackClient) => Promise<number>, o?: object) => Promise<number>)(
        async (tx) => {
          const missed: string[] = [];
          let n = 0;
          for (const { r } of revertible) {
            // Exactly the six columns the repair wrote — a literal, so every reader
            // (and audit-account-reparenting) can see no FK is in the payload.
            const res = await tx.transaction.updateMany({
              where: afterGuard(r) as never,
              data: {
                flowType: r.before.flowType,
                category: r.before.category,
                flowAuthority: r.before.flowAuthority,
                classifierVersion: r.before.classifierVersion,
                classificationReason: r.before.classificationReason,
                classificationConfidence: r.before.classificationConfidence,
              } as never,
            });
            if (res.count === 1) n++; else missed.push(r.id);
          }
          if (missed.length) throw new RollbackConflict(missed);
          return n;
        },
        { timeout: 60_000, maxWait: 10_000 },
      );
      outcome = "APPLIED";
    } catch (e) {
      if (!(e instanceof RollbackConflict)) throw e;
      conflictIds = e.ids;
      outcome = "ABORTED_CONFLICT";
    }
  }

  const count = (s: RollbackRowState) => rows.filter((x) => x.state === s).length;
  return {
    rule: `${REPAIR_RULE} — rollback`,
    generatedAt: now().toISOString(),
    mode: opts.apply ? "APPLY" : "DRY_RUN",
    outcome,
    context: { ...opts.context },
    source: { generatedAt: restore.generatedAt, state: restore.state, rows: restore.rows.length, checksum: restore.checksum.slice(0, 16) },
    expect,
    totals: {
      inFile: restore.rows.length, revertible: revertible.length, reverted,
      drifted: count("DRIFTED"), userCategory: count("USER_CATEGORY"), missing: count("MISSING"),
      tombstoned: rows.filter((x) => x.tombstoned).length, conflicts: conflictIds.length,
    },
    rows: rows.map(({ r, state, tombstoned }) => ({ idHash: r.idHash, state, tombstoned, restoreTo: { ...r.before } })),
    conflictIdHashes: conflictIds.map(hashId),
  };
}

export function summarizeRollbackReport(r: RollbackReport, envLabel: string | null): string {
  const lines: string[] = [];
  lines.push(`[${r.mode === "APPLY" ? "APPLY" : "DRY RUN"}] ${r.rule}${envLabel ? ` · env=${envLabel}` : ""}`);
  if (r.context.targetHash) lines.push(`  target: ${r.context.targetHash}${r.context.approvalTicket ? ` · owner approval ${r.context.approvalTicket}` : ""}`);
  lines.push(`  source: restore file ${r.source.checksum} (${r.source.rows} row(s), repair state ${r.source.state}, ${r.source.generatedAt})`);
  const t = r.totals;
  lines.push(`  revertible ${t.revertible} · drifted ${t.drifted} · user category ${t.userCategory} · missing ${t.missing} · tombstoned ${t.tombstoned}`);
  if (r.expect) lines.push(`  expect ${r.expect.count}: ${r.expect.matched ? "MATCHED" : `MISMATCH (revertible ${t.revertible})`}`);
  for (const x of r.rows) {
    lines.push(`  ${x.idHash.padEnd(13)}${x.state.padEnd(14)}→ ${x.restoreTo.flowType}/${x.restoreTo.category} ${x.restoreTo.flowAuthority} v${x.restoreTo.classifierVersion ?? "∅"} ${x.restoreTo.classificationReason}@${x.restoreTo.classificationConfidence}${x.tombstoned ? " (tombstoned)" : ""}`);
  }
  lines.push("");
  switch (r.outcome) {
    case "APPLIED": lines.push(`  ROLLED BACK — ${t.reverted} row(s) restored in one transaction.`); break;
    case "NOTHING_TO_DO": lines.push("  APPLY — nothing revertible."); break;
    case "REFUSED_EXPECT_MISMATCH": lines.push(`  REFUSED — --expect=${r.expect?.count} but ${t.revertible} row(s) are revertible. Nothing written.`); break;
    case "ABORTED_CONFLICT": lines.push(`  ABORTED — ${t.conflicts} row(s) changed since planning; rolled back. Nothing written.`); break;
    default: lines.push("  Dry run — nothing written.");
  }
  return lines.join("\n");
}
