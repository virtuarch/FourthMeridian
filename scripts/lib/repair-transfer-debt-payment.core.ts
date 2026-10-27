/**
 * scripts/lib/repair-transfer-debt-payment.core.ts
 *
 * v2.7-P1 — the testable core of scripts/repair-transfer-debt-payment.ts.
 * Client-injected (no `@/lib/db` import), so the whole repair — selection, plan,
 * guarded write, audit report — runs against an in-memory fake in tests and
 * against nothing real unless the CLI wrapper's environment gate allows it.
 *
 * Selection is the SAME planner the Plaid sync uses after every completed sync
 * (lib/transactions/transfer-debt-payment-correction-write.ts), over the
 * historical corpus instead of one sync's touched rows. Nothing here chooses rows
 * by institution, merchant or descriptor; the transfer authority's evidence and
 * the stored provider category code are the only inputs.
 */

import { createHash } from "node:crypto";
import {
  applyTransferDebtPaymentCorrections,
  candidateWhere,
  loadCorrectionCandidates,
  planTransferDebtPaymentCorrections,
  type CorrectionClient,
  type PlannedCorrection,
} from "@/lib/transactions/transfer-debt-payment-correction-write";
import { DEPOSITORY_ACCOUNT_TYPES, type CorrectionKind } from "@/lib/transactions/transfer-debt-payment-correction";

export const REPAIR_RULE = "v2.7-P1 transfer-authority debt-payment correction";

export interface RepairOptions {
  apply: boolean;
  /** Restrict to the depository accounts ACTIVELY linked into this Space. */
  spaceId?: string | null;
  /** Clock seam for the report. */
  now?: () => Date;
}

export interface RepairReportRow {
  /** sha256(id), first 12 hex — joinable by an operator, not a raw id. */
  idHash: string;
  /** Account TYPE and last four of the mask, e.g. "checking ••••1234". */
  account: string;
  /** Economic day (falls back to posting day). */
  date: string;
  amount: number;
  lifecycle: "POSTED" | "PENDING";
  before: { flowType: string | null; category: string | null; flowAuthority: string | null; classificationReason: string | null; classificationConfidence: number | null };
  after: { flowType: string; category: string; flowAuthority: "TRANSFER_AUTHORITY"; classificationReason: string; classificationConfidence: number };
  kind: CorrectionKind;
  arm: "A" | "B";
  evidence: string;
  maturity: string;
}

export interface RepairReport {
  rule: string;
  generatedAt: string;
  mode: "DRY_RUN" | "APPLY";
  scope: { spaceIdHash: string | null };
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
  /** Candidates left untouched, by the rule's reason code. */
  untouched: Record<string, number>;
  rows: RepairReportRow[];
  /** Pending rows whose posted twin is live: NOT rewritten — they retire. */
  retiringPending: { idHash: string; account: string; date: string; amount: number }[];
}

export const hashId = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 12);
const round2 = (n: number) => Math.round(n * 100) / 100;
const dayOf = (r: { economicDate: Date | null; date: Date }) => (r.economicDate ?? r.date).toISOString().slice(0, 10);

/** Run the repair. Writes ONLY when `apply` is true; the caller owns the environment gate. */
export async function runTransferDebtPaymentRepair(client: CorrectionClient, opts: RepairOptions): Promise<RepairReport> {
  const now = opts.now ?? (() => new Date());

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

  let written = 0;
  let conflicts: string[] = [];
  if (opts.apply && plan.writes.length > 0) {
    const r = await applyTransferDebtPaymentCorrections(client, plan.writes);
    written = r.written;
    conflicts = r.conflicts;
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
      before: { ...p.before },
      after: { ...p.after, flowAuthority: "TRANSFER_AUTHORITY" as const },
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
    generatedAt: now().toISOString(),
    mode: opts.apply ? "APPLY" : "DRY_RUN",
    scope: { spaceIdHash: opts.spaceId ? hashId(opts.spaceId) : null },
    totals: {
      scanned: plan.scanned,
      proposed: rows.length,
      written,
      conflicts: conflicts.length,
      amount: sum(rows),
      posted: { count: posted.length, amount: sum(posted) },
      pending: { count: pending.length, amount: sum(pending) },
      byKind,
      retiringPending: { count: retiring.length, amount: sum(retiring) },
    },
    untouched: { ...plan.untouched } as Record<string, number>,
    rows,
    retiringPending: retiring,
  };
}

/** The human summary — the same facts as the JSON, no ids beyond the hash. */
export function summarizeRepairReport(r: RepairReport, envLabel: string | null): string {
  const lines: string[] = [];
  lines.push(`[${r.mode === "APPLY" ? "APPLY" : "DRY RUN"}] ${r.rule}${envLabel ? ` · env=${envLabel}` : ""}`);
  lines.push(`  scope: ${r.scope.spaceIdHash ? `space ${r.scope.spaceIdHash}` : "all depository accounts"}`);
  lines.push(`  scanned ${r.totals.scanned} candidate(s); proposed ${r.totals.proposed} (${r.totals.amount.toFixed(2)})`);
  lines.push(`    posted  ${r.totals.posted.count} (${r.totals.posted.amount.toFixed(2)})`);
  lines.push(`    pending ${r.totals.pending.count} (${r.totals.pending.amount.toFixed(2)})  — live pending rows with NO posted twin`);
  lines.push(`    by kind ${Object.entries(r.totals.byKind).map(([k, n]) => `${k}=${n}`).join(" ") || "none"}`);
  lines.push(`  retiring pending (posted twin live; NOT rewritten): ${r.totals.retiringPending.count} (${r.totals.retiringPending.amount.toFixed(2)})`);
  const untouched = Object.entries(r.untouched).map(([k, n]) => `${k}=${n}`).join(" ");
  lines.push(`  untouched: ${untouched || "none"}`);
  if (r.rows.length > 0) {
    lines.push("");
    lines.push(`  ${"id#".padEnd(13)}${"account".padEnd(18)}${"date".padEnd(11)}${"amount".padStart(11)}  ${"lc".padEnd(8)}${"before → after".padEnd(42)}evidence / maturity`);
    for (const x of r.rows) {
      const change = `${x.before.flowType}/${x.before.category} → ${x.after.flowType}/${x.after.category}`;
      lines.push(`  ${x.idHash.padEnd(13)}${x.account.padEnd(18)}${x.date.padEnd(11)}${x.amount.toFixed(2).padStart(11)}  ${x.lifecycle.padEnd(8)}${change.padEnd(42)}${x.evidence} / ${x.maturity} [${x.kind}]`);
    }
  }
  lines.push("");
  lines.push(r.mode === "APPLY"
    ? `  APPLIED — ${r.totals.written} row(s) written${r.totals.conflicts ? `, ${r.totals.conflicts} changed concurrently and left alone` : ""}.`
    : "  Dry run — nothing written. Re-run with --apply --env=preview|local to write.");
  return lines.join("\n");
}
