/**
 * scripts/lib/repair-transfer-debt-payment.core.ts
 *
 * v2.7-P1 — the testable core of scripts/repair-transfer-debt-payment.ts.
 * Client-injected (no `@/lib/db` import), so the whole repair — selection, plan,
 * guarded write, audit report, restore record — runs against an in-memory fake in
 * tests and against nothing real unless the CLI wrapper's environment gate allows it.
 *
 * Selection is the SAME planner the Plaid sync uses after every completed sync
 * (lib/transactions/transfer-debt-payment-correction-write.ts), over the
 * historical corpus instead of one sync's touched rows. Nothing here chooses rows
 * by institution, merchant or descriptor; the transfer authority's evidence and
 * the stored provider category code are the only inputs.
 *
 * ── Apply discipline (repair readiness) ─────────────────────────────────────
 *
 *   1. PLAN (read-only).
 *   2. `--expect` — when given, the plan's write count must equal it, or nothing
 *      is written (outcome REFUSED_EXPECT_MISMATCH). Mandatory for Production
 *      (the gate enforces that).
 *   3. RESTORE RECORD — persisted by the caller BEFORE the first write
 *      (`persistRestore`); if persisting throws, nothing is written. It carries
 *      the raw row ids and the full BEFORE and AFTER values of every column the
 *      write changes, so `--rollback` can restore the exact prior state even if
 *      the process dies right after the commit.
 *   4. STRICT WRITE — ONE interactive transaction; each row's `updateMany` is
 *      guarded by its full BEFORE shape (`correctionGuardWhere`, shared with the
 *      sync-time pass). If ANY row no longer matches, the transaction is rolled
 *      back and NOTHING is written (outcome ABORTED_CONFLICT) — the repair is
 *      all-or-nothing, so `written` is always either the expected count or 0.
 *      (The sync-time pass keeps its own per-row, partial applier.)
 */

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  candidateWhere,
  correctionGuardWhere,
  correctionWriteData,
  loadCorrectionCandidates,
  planTransferDebtPaymentCorrections,
  type CorrectionClient,
  type PlannedCorrection,
} from "@/lib/transactions/transfer-debt-payment-correction-write";
import { DEPOSITORY_ACCOUNT_TYPES, type CorrectionKind } from "@/lib/transactions/transfer-debt-payment-correction";
import { assertMayWriteFlow, type FlowAuthorityName } from "@/lib/transactions/flow-authority";

export const REPAIR_RULE = "v2.7-P1 transfer-authority debt-payment correction";

/** The columns the repair writes — and therefore exactly what a rollback restores. */
export interface RestorableColumns {
  flowType: string | null;
  category: string | null;
  flowAuthority: string | null;
  classifierVersion: number | null;
  classificationReason: string | null;
  classificationConfidence: number | null;
}
export const RESTORABLE_COLUMNS = [
  "flowType", "category", "flowAuthority", "classifierVersion", "classificationReason", "classificationConfidence",
] as const satisfies readonly (keyof RestorableColumns)[];

/** Facts about the run the CLI's gate established. Never a URL, host or secret. */
export interface RepairContext {
  env: string | null;
  /** sha256 of the logical database identity (scripts/lib/repair-env-guard.ts). */
  targetHash: string | null;
  approvalTicket: string | null;
}

export interface RepairOptions {
  apply: boolean;
  /** Restrict to the depository accounts ACTIVELY linked into this Space. */
  spaceId?: string | null;
  /** Clock seam for the report. */
  now?: () => Date;
  /** The operator's expected write count. A mismatch writes nothing. */
  expect?: number | null;
  context?: RepairContext;
  /**
   * Persist the restore record. REQUIRED for apply: called once BEFORE the first
   * write (state PLANNED — a throw here aborts with nothing written) and again
   * after the outcome is known (APPLIED / ABORTED).
   */
  persistRestore?: (restore: RestoreFile) => void | Promise<void>;
}

export type RepairOutcome =
  | "DRY_RUN"
  | "NOTHING_TO_DO"
  | "APPLIED"
  | "REFUSED_EXPECT_MISMATCH"
  | "ABORTED_CONFLICT";

export interface RepairReportRow {
  /** sha256(id), first 12 hex — joinable by an operator, not a raw id. */
  idHash: string;
  /** Account TYPE and last four of the mask, e.g. "checking ••••1234". */
  account: string;
  /** Economic day (falls back to posting day). */
  date: string;
  amount: number;
  lifecycle: "POSTED" | "PENDING";
  before: RestorableColumns;
  after: RestorableColumns & { flowAuthority: "TRANSFER_AUTHORITY"; classifierVersion: null };
  kind: CorrectionKind;
  arm: "A" | "B";
  evidence: string;
  maturity: string;
}

export interface RepairReport {
  rule: string;
  generatedAt: string;
  mode: "DRY_RUN" | "APPLY";
  outcome: RepairOutcome;
  context: RepairContext;
  scope: { spaceIdHash: string | null };
  /** The operator's expectation and whether the plan met it (null when none was given). */
  expect: { count: number; matched: boolean } | null;
  totals: {
    scanned: number;
    proposed: number;
    written: number;
    conflicts: number;
    amount: number;
    posted: { count: number; amount: number };
    pending: { count: number; amount: number };
    byKind: Partial<Record<CorrectionKind, number>>;
    retiringPending: { count: number; amount: number };
  };
  /** Rows whose BEFORE shape no longer held at write time (hashed). Non-empty ⇒ nothing was written. */
  conflictIdHashes: string[];
  /** Candidates left untouched, by the rule's reason code. */
  untouched: Record<string, number>;
  rows: RepairReportRow[];
  /** Pending rows whose posted twin is live: NOT rewritten — they retire. */
  retiringPending: { idHash: string; account: string; date: string; amount: number }[];
}

/** The RESTRICTED rollback source. Raw ids — never commit, paste or share it. */
export interface RestoreFile {
  kind: "fm.repair-transfer-debt-payment.restore";
  version: 1;
  warning: string;
  rule: string;
  generatedAt: string;
  context: RepairContext;
  state: "PLANNED" | "APPLIED" | "ABORTED";
  written: number;
  rows: RestoreRow[];
  /** sha256 of JSON.stringify(rows) — detects truncation or hand edits. */
  checksum: string;
}
export interface RestoreRow {
  id: string;
  idHash: string;
  before: RestorableColumns;
  after: RestorableColumns;
}

export const RESTORE_WARNING =
  "RESTRICTED — contains raw Transaction ids. Do not commit, paste or share. Keep (0600) until the rollback window closes, then delete.";

export const hashId = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 12);
export const restoreChecksum = (rows: readonly RestoreRow[]): string =>
  createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const round2 = (n: number) => Math.round(n * 100) / 100;
const dayOf = (r: { economicDate: Date | null; date: Date }) => (r.economicDate ?? r.date).toISOString().slice(0, 10);

class RepairConflict extends Error {
  constructor(readonly ids: string[]) { super(`repair aborted: ${ids.length} row(s) changed since planning`); }
}

/** The AFTER values of one planned write, over every restorable column. */
function afterOf(p: PlannedCorrection): RestorableColumns & { flowAuthority: "TRANSFER_AUTHORITY"; classifierVersion: null } {
  return {
    flowType: p.after.flowType,
    category: p.after.category,
    flowAuthority: "TRANSFER_AUTHORITY",
    classifierVersion: null,
    classificationReason: p.after.classificationReason,
    classificationConfidence: p.after.classificationConfidence,
  };
}
/** The classifier's version per planned row — read by the repair, never by the lib writer. */
type VersionMap = ReadonlyMap<string, number | null>;

async function readClassifierVersions(client: CorrectionClient, writes: readonly PlannedCorrection[]): Promise<VersionMap> {
  const out = new Map<string, number | null>();
  const ids = writes.map((p) => p.row.id);
  for (let i = 0; i < ids.length; i += 1000) {
    const page = await client.transaction.findMany({
      where: { id: { in: ids.slice(i, i + 1000) } },
      select: { id: true, classifierVersion: true },
    }) as unknown as { id: string; classifierVersion: number | null }[];
    for (const r of page) out.set(r.id, r.classifierVersion ?? null);
  }
  return out;
}

function beforeOf(p: PlannedCorrection, versions: VersionMap): RestorableColumns {
  return {
    flowType: p.before.flowType,
    category: p.before.category,
    flowAuthority: p.before.flowAuthority,
    classifierVersion: versions.get(p.row.id) ?? null,
    classificationReason: p.before.classificationReason,
    classificationConfidence: p.before.classificationConfidence,
  };
}

export function buildRestoreFile(writes: readonly PlannedCorrection[], versions: VersionMap, ctx: RepairContext, generatedAt: string): RestoreFile {
  const rows: RestoreRow[] = writes.map((p) => ({ id: p.row.id, idHash: hashId(p.row.id), before: beforeOf(p, versions), after: afterOf(p) }));
  return {
    kind: "fm.repair-transfer-debt-payment.restore", version: 1, warning: RESTORE_WARNING,
    rule: REPAIR_RULE, generatedAt, context: { ...ctx }, state: "PLANNED", written: 0,
    rows, checksum: restoreChecksum(rows),
  };
}

/**
 * The strict applier: ONE interactive transaction, the shared per-row guard PLUS
 * the classifier version the restore record captured (so the record is exactly
 * what was overwritten), and all-or-nothing — any guard miss throws and rolls the
 * whole write back.
 */
async function applyStrict(client: CorrectionClient, writes: readonly PlannedCorrection[], versions: VersionMap): Promise<number> {
  for (const p of writes) {
    // The ownership model, consulted at the write site (as the lib applier does).
    assertMayWriteFlow(p.before.flowAuthority as FlowAuthorityName | null, "TRANSFER_AUTHORITY",
      "repair-transfer-debt-payment", ["CLASSIFIER"]);
  }
  return await (client.$transaction as unknown as (fn: (tx: CorrectionClient) => Promise<number>, o?: object) => Promise<number>)(
    async (tx) => {
      const missed: string[] = [];
      let n = 0;
      for (const p of writes) {
        const r = await tx.transaction.updateMany({
          where: { ...correctionGuardWhere(p), classifierVersion: versions.get(p.row.id) ?? null } as Prisma.TransactionWhereInput,
          data: correctionWriteData(p),
        });
        if (r.count === 1) n++; else missed.push(p.row.id);
      }
      if (missed.length) throw new RepairConflict(missed);
      return n;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}

/** Run the repair. Writes ONLY when `apply` is true; the caller owns the environment gate. */
export async function runTransferDebtPaymentRepair(client: CorrectionClient, opts: RepairOptions): Promise<RepairReport> {
  const now = opts.now ?? (() => new Date());
  const ctx: RepairContext = opts.context ?? { env: null, targetHash: null, approvalTicket: null };
  if (opts.apply && !opts.persistRestore) {
    throw new Error("repair-transfer-debt-payment: apply requires persistRestore — no write without a durable restore record.");
  }

  // Scope → the depository accounts the rule may touch.
  const accounts = opts.spaceId
    ? (await client.spaceAccountLink.findMany({
        where: { spaceId: opts.spaceId, status: "ACTIVE", financialAccount: { deletedAt: null } } as never,
        select: { financialAccount: { select: { id: true, type: true, mask: true } } },
      }) as unknown as { financialAccount: { id: string; type: string; mask: string | null } }[]).map((l) => l.financialAccount)
    : await client.financialAccount.findMany({
        where: { deletedAt: null, type: { in: [...DEPOSITORY_ACCOUNT_TYPES] as never } },
        select: { id: true, type: true, mask: true },
      }) as unknown as { id: string; type: string; mask: string | null }[];
  const depository = accounts.filter((a) => DEPOSITORY_ACCOUNT_TYPES.has(a.type));
  const accountLabel = new Map(depository.map((a) => [a.id, `${a.type} ••••${(a.mask ?? "????").slice(-4)}`]));

  const candidates = depository.length > 0
    ? await loadCorrectionCandidates(client, candidateWhere(depository.map((a) => a.id)))
    : [];
  const plan = await planTransferDebtPaymentCorrections(client, candidates);
  const versions = await readClassifierVersions(client, plan.writes);
  const generatedAt = now().toISOString();

  const expect = opts.expect == null ? null : { count: opts.expect, matched: opts.expect === plan.writes.length };

  let outcome: RepairOutcome = opts.apply ? "NOTHING_TO_DO" : "DRY_RUN";
  let written = 0;
  let conflictIds: string[] = [];
  if (opts.apply && expect && !expect.matched) {
    outcome = "REFUSED_EXPECT_MISMATCH";
  } else if (opts.apply && plan.writes.length > 0) {
    const restore = buildRestoreFile(plan.writes, versions, ctx, generatedAt);
    await opts.persistRestore!(restore);          // a throw here: nothing written
    try {
      written = await applyStrict(client, plan.writes, versions);
      outcome = "APPLIED";
      await opts.persistRestore!({ ...restore, state: "APPLIED", written });
    } catch (e) {
      if (!(e instanceof RepairConflict)) throw e;  // the transaction rolled back; restore stays PLANNED
      conflictIds = e.ids;
      outcome = "ABORTED_CONFLICT";
      await opts.persistRestore!({ ...restore, state: "ABORTED", written: 0 });
    }
  }

  const rows: RepairReportRow[] = plan.writes
    .slice()
    .sort((a, b) => dayOf(a.row).localeCompare(dayOf(b.row)) || hashId(a.row.id).localeCompare(hashId(b.row.id)))
    .map((p: PlannedCorrection) => ({
      idHash: hashId(p.row.id),
      account: accountLabel.get(p.row.financialAccountId ?? "") ?? p.ownAccountType,
      date: dayOf(p.row),
      amount: round2(p.row.amount),
      lifecycle: p.row.pending ? "PENDING" : "POSTED",
      before: beforeOf(p, versions),
      after: afterOf(p),
      kind: p.kind,
      arm: p.arm,
      evidence: p.evidenceLevel,
      maturity: p.maturity,
    }));

  const sum = (xs: { amount: number }[]) => round2(xs.reduce((n, x) => n + x.amount, 0));
  const posted = rows.filter((r) => r.lifecycle === "POSTED");
  const pending = rows.filter((r) => r.lifecycle === "PENDING");
  const byKind: Partial<Record<CorrectionKind, number>> = {};
  for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  const retiring = plan.retiringPending.map((c) => ({
    idHash: hashId(c.id),
    account: accountLabel.get(c.financialAccountId ?? "") ?? "depository",
    date: dayOf(c),
    amount: round2(c.amount),
  }));

  return {
    rule: REPAIR_RULE,
    generatedAt,
    mode: opts.apply ? "APPLY" : "DRY_RUN",
    outcome,
    context: { ...ctx },
    scope: { spaceIdHash: opts.spaceId ? hashId(opts.spaceId) : null },
    expect,
    totals: {
      scanned: plan.scanned,
      proposed: rows.length,
      written,
      conflicts: conflictIds.length,
      amount: sum(rows),
      posted: { count: posted.length, amount: sum(posted) },
      pending: { count: pending.length, amount: sum(pending) },
      byKind,
      retiringPending: { count: retiring.length, amount: sum(retiring) },
    },
    conflictIdHashes: conflictIds.map(hashId),
    untouched: { ...plan.untouched } as Record<string, number>,
    rows,
    retiringPending: retiring,
  };
}

/** The human summary — the same facts as the JSON, no ids beyond the hash. */
export function summarizeRepairReport(r: RepairReport, envLabel: string | null): string {
  const lines: string[] = [];
  lines.push(`[${r.mode === "APPLY" ? "APPLY" : "DRY RUN"}] ${r.rule}${envLabel ? ` · env=${envLabel}` : ""}`);
  if (r.context.targetHash) lines.push(`  target: ${r.context.targetHash}${r.context.approvalTicket ? ` · owner approval ${r.context.approvalTicket}` : ""}`);
  lines.push(`  scope: ${r.scope.spaceIdHash ? `space ${r.scope.spaceIdHash}` : "all depository accounts"}`);
  lines.push(`  scanned ${r.totals.scanned} candidate(s); proposed ${r.totals.proposed} (${r.totals.amount.toFixed(2)})`);
  lines.push(`    posted  ${r.totals.posted.count} (${r.totals.posted.amount.toFixed(2)})`);
  lines.push(`    pending ${r.totals.pending.count} (${r.totals.pending.amount.toFixed(2)})  — live pending rows with NO posted twin`);
  lines.push(`    by kind ${Object.entries(r.totals.byKind).map(([k, n]) => `${k}=${n}`).join(" ") || "none"}`);
  lines.push(`  retiring pending (posted twin live; NOT rewritten): ${r.totals.retiringPending.count} (${r.totals.retiringPending.amount.toFixed(2)})`);
  const untouched = Object.entries(r.untouched).map(([k, n]) => `${k}=${n}`).join(" ");
  lines.push(`  untouched: ${untouched || "none"}`);
  if (r.expect) lines.push(`  expect ${r.expect.count}: ${r.expect.matched ? "MATCHED" : `MISMATCH (plan has ${r.totals.proposed})`}`);
  if (r.rows.length > 0) {
    lines.push("");
    lines.push(`  ${"id#".padEnd(13)}${"account".padEnd(18)}${"date".padEnd(11)}${"amount".padStart(11)}  ${"lc".padEnd(8)}${"before → after".padEnd(42)}evidence / maturity`);
    for (const x of r.rows) {
      const change = `${x.before.flowType}/${x.before.category} → ${x.after.flowType}/${x.after.category}`;
      lines.push(`  ${x.idHash.padEnd(13)}${x.account.padEnd(18)}${x.date.padEnd(11)}${x.amount.toFixed(2).padStart(11)}  ${x.lifecycle.padEnd(8)}${change.padEnd(42)}${x.evidence} / ${x.maturity} [${x.kind}]`);
    }
  }
  lines.push("");
  switch (r.outcome) {
    case "APPLIED":
      lines.push(`  APPLIED — ${r.totals.written} row(s) written in one transaction.`); break;
    case "NOTHING_TO_DO":
      lines.push("  APPLY — nothing to write."); break;
    case "REFUSED_EXPECT_MISMATCH":
      lines.push(`  REFUSED — --expect=${r.expect?.count} but the plan has ${r.totals.proposed}. Nothing written. Re-run the dry run and investigate.`); break;
    case "ABORTED_CONFLICT":
      lines.push(`  ABORTED — ${r.totals.conflicts} row(s) changed since planning; the transaction was rolled back. Nothing written.`); break;
    default:
      lines.push("  Dry run — nothing written. Re-run with --apply --env=<env> --out=<report.json> to write.");
  }
  return lines.join("\n");
}
