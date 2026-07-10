/**
 * scripts/backfill-transfer-evidence.ts
 *
 * TE1 — provider-neutral transfer-evidence backfill. DRY-RUN by default.
 *
 * Reads live canonical flowType = TRANSFER rows, plans each through the SAME
 * write-boundary planner the sync path uses (planTransferEvidence → the Plaid
 * adapter + neutral mapper + authority/replay reconcile), and reports what WOULD
 * be written. It is:
 *   - deterministic, idempotent, versioned, replayable;
 *   - read-only in dry-run (the default) — NO database writes;
 *   - authority-preserving (never overwrites a higher-authority stored value);
 *   - scoped to flowType = TRANSFER only.
 *
 * Non-Plaid/import rows (no plaidTransactionId) get NO adapter and stay
 * unclassified — reported as "non_provider", never a Plaid-derived default.
 *
 * Run (read-only):
 *   npx tsx scripts/backfill-transfer-evidence.ts [--batch=N] [--limit=N]
 * Apply (writes; requires the migration applied — NOT run during validation):
 *   npx tsx scripts/backfill-transfer-evidence.ts --apply
 *
 * Output is aggregate + non-PII (counts only; no merchant/amount/description).
 */

import { db } from "@/lib/db";
import { planTransferEvidence } from "@/lib/transactions/transfer-evidence-plan";
import { NULL_TRANSFER_EVIDENCE_FIELDS, type TransferEvidenceFields } from "@/lib/transactions/transfer-evidence-write";

const argv = process.argv.slice(2);
function intFlag(name: string, def: number): number {
  const a = argv.find((x) => x.startsWith(`${name}=`));
  const n = a ? parseInt(a.split("=")[1] ?? "", 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : def;
}
const APPLY = argv.includes("--apply");
const BATCH = intFlag("--batch", 1000);
const LIMIT = intFlag("--limit", Number.POSITIVE_INFINITY);

function inc(m: Map<string, number>, k: string, by = 1) { m.set(k, (m.get(k) ?? 0) + by); }
function familyOf(d: string): string {
  let s = d.toUpperCase();
  while (s.startsWith("TRANSFER_IN_") || s.startsWith("TRANSFER_OUT_")) {
    s = s.startsWith("TRANSFER_IN_") ? s.slice(12) : s.slice(13);
  }
  return s;
}

async function main(): Promise<void> {
  console.log(`\n${APPLY ? "[APPLY] transfer-evidence backfill — WRITING" : "[DRY RUN] transfer-evidence backfill — READ-ONLY, no writes"}`);
  console.log("Scope: live flowType = TRANSFER (deletedAt: null)\n");

  const agg = {
    examined: 0, plaid: 0, nonPlaid: 0,
    signal: new Map<string, number>(),
    reconcile: new Map<string, number>(),
    rail: new Map<string, number>(), form: new Map<string, number>(),
    venue: new Map<string, number>(), direction: new Map<string, number>(),
    sourceVersion: new Map<string, number>(), family: new Map<string, number>(),
    afterProposed: new Map<string, number>(), // per-field: rows that WOULD be populated
    beforePopulated: new Map<string, number>(), // per-field: rows currently populated
    wouldWrite: 0,
  };
  const FIELDS: (keyof TransferEvidenceFields)[] = [
    "transferRail", "transferMovementForm", "transferVenueClass",
    "transferEvidenceConfidence", "transferEvidenceReason", "transferEvidenceSource", "transferEvidenceVersion",
  ];

  let cursor: string | undefined;
  while (agg.examined < LIMIT) {
    const take = Math.min(BATCH, LIMIT - agg.examined);
    // Dry-run reads ONLY existing columns (the new columns may be unmigrated).
    // Apply additionally reads stored evidence to reconcile before writing.
    const rows = await db.transaction.findMany({
      where: { deletedAt: null, flowType: "TRANSFER" },
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take,
      select: {
        id: true, plaidTransactionId: true, pfcDetailed: true, amount: true,
        // CF-P1 — the raw name lets the adapter recognize a known payment-app rail.
        merchant: true, description: true,
        ...(APPLY ? {
          transferRail: true, transferMovementForm: true, transferVenueClass: true,
          transferEvidenceConfidence: true, transferEvidenceReason: true,
          transferEvidenceSource: true, transferEvidenceVersion: true,
        } : {}),
      },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    for (const r of rows) {
      agg.examined++;
      if (r.plaidTransactionId != null) agg.plaid++; else agg.nonPlaid++;
      if (r.pfcDetailed) inc(agg.family, familyOf(r.pfcDetailed));

      const stored: TransferEvidenceFields = APPLY
        ? {
            transferRail: (r as Record<string, unknown>).transferRail as never ?? null,
            transferMovementForm: (r as Record<string, unknown>).transferMovementForm as never ?? null,
            transferVenueClass: (r as Record<string, unknown>).transferVenueClass as never ?? null,
            transferEvidenceConfidence: (r as Record<string, unknown>).transferEvidenceConfidence as never ?? null,
            transferEvidenceReason: (r as Record<string, unknown>).transferEvidenceReason as never ?? null,
            transferEvidenceSource: (r as Record<string, unknown>).transferEvidenceSource as never ?? null,
            transferEvidenceVersion: (r as Record<string, unknown>).transferEvidenceVersion as never ?? null,
          }
        : NULL_TRANSFER_EVIDENCE_FIELDS; // dry-run: columns unmigrated ⇒ treat as unpopulated (accurate)

      for (const f of FIELDS) if (stored[f] != null) inc(agg.beforePopulated, f);

      const plan = planTransferEvidence({ plaidTransactionId: r.plaidTransactionId, pfcDetailed: r.pfcDetailed, amount: r.amount, name: r.merchant ?? r.description ?? null, stored });
      inc(agg.signal, plan.signal);
      inc(agg.reconcile, plan.reconcile.reason);

      if (plan.signal === "recognized") {
        const p = plan.proposed;
        if (p.transferRail) inc(agg.rail, p.transferRail);
        if (p.transferMovementForm) inc(agg.form, p.transferMovementForm);
        if (p.transferVenueClass) inc(agg.venue, p.transferVenueClass);
        inc(agg.direction, r.amount > 0 ? "IN" : r.amount < 0 ? "OUT" : "ZERO");
        inc(agg.sourceVersion, `${p.transferEvidenceSource}@${p.transferEvidenceVersion}`);
        for (const f of FIELDS) if (p[f] != null) inc(agg.afterProposed, f);
      }

      if (plan.reconcile.write) {
        agg.wouldWrite++;
        if (APPLY) {
          const p = plan.proposed;
          await db.transaction.update({
            where: { id: r.id },
            data: {
              transferRail: p.transferRail, transferMovementForm: p.transferMovementForm,
              transferVenueClass: p.transferVenueClass, transferEvidenceConfidence: p.transferEvidenceConfidence,
              transferEvidenceReason: p.transferEvidenceReason, transferEvidenceSource: p.transferEvidenceSource,
              transferEvidenceVersion: p.transferEvidenceVersion,
            },
          });
        }
      }
    }
    if (rows.length < take) break;
  }

  const show = (label: string, m: Map<string, number>) =>
    console.log(`  ${label}: ${[...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ") || "(none)"}`);

  console.log(`Examined (flowType=TRANSFER): ${agg.examined}`);
  console.log(`  Plaid-sourced: ${agg.plaid}   Non-Plaid/import/manual: ${agg.nonPlaid}`);
  show("By signal", agg.signal);
  show("By reconcile outcome", agg.reconcile);
  console.log(`  Rows that WOULD change (write): ${agg.wouldWrite}`);
  show("By rail type", agg.rail);
  show("By movement form", agg.form);
  show("By venue class", agg.venue);
  show("By direction", agg.direction);
  show("By source@version", agg.sourceVersion);
  show("Exact mapped Plaid family", agg.family);
  console.log("  Before population (per field):");
  for (const f of FIELDS) console.log(`    ${f}: ${agg.beforePopulated.get(f) ?? 0}`);
  console.log(`  After (proposed) population (per field)${APPLY ? "" : " — what apply would populate"}:`);
  for (const f of FIELDS) console.log(`    ${f}: ${agg.afterProposed.get(f) ?? 0}`);

  const recognized = agg.signal.get("recognized") ?? 0;
  const nonProvider = agg.signal.get("non_provider") ?? 0;
  console.log(`\nReconciliation: recognized(${recognized}) + no_signal(${agg.signal.get("no_signal") ?? 0}) + ` +
    `unrecognized(${agg.signal.get("unrecognized") ?? 0}) + non_provider(${nonProvider}) = ${agg.examined} total TRANSFER rows.`);

  await db.$disconnect();
}

main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
