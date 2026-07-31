/**
 * scripts/dry-run-acquisition.ts
 *
 * V26-PRICE-4 — the acquisition BUDGET REPORT. READ-ONLY.
 *
 *     npx dotenv -e .env.local -- npx tsx scripts/dry-run-acquisition.ts
 *
 * ╔════════════════════════════════════════════════════════════════════════╗
 * ║  DRY RUN. No provider is contacted. No row is written. This report     ║
 * ║  exists to be APPROVED OR REFUSED before any credits are spent.        ║
 * ╚════════════════════════════════════════════════════════════════════════╝
 *
 * Structurally read-only: every DB statement is a SELECT, and there is no code
 * path from here to fetchInstrumentWindow or priceArchive.writeBatch. It reports
 * what a real run WOULD do, using the identical ownership → coverage →
 * acquisition → budget chain the run itself uses, so the estimate and the
 * execution cannot drift.
 *
 * The confidence split is the part worth reading twice. Two windows costing the
 * same credits are not the same purchase: one buys prices for history we have
 * direct evidence of holding, the other buys prices for history we merely infer
 * could have been held. Both are legitimate; only the second needs disclosure
 * downstream.
 *
 * Exit codes: 0 = report produced · 1 = a plan needs attention · 2 = query failure.
 */

import { db } from "@/lib/db";
import { PriceBasis } from "@prisma/client";
import { yesterdayUTCISO } from "@/lib/prices/config";
import { defaultPriceRegistry } from "@/lib/prices/registry";
import { loadInstrumentCoverage } from "@/lib/prices/coverage-binding";
import { resolveProviderForInstrument } from "@/lib/prices/registry";
import { loadOwnershipWindows } from "@/lib/prices/ownership-window";
import { planAcquisition, type AcquisitionPlan } from "@/lib/prices/acquisition-plan.core";
import { estimateAcquisitionBudget, type BudgetInput } from "@/lib/prices/acquisition-budget.core";
import type { OwnershipSegment } from "@/lib/prices/ownership-window.core";

/** Vendor request limit and cost assumptions the report is computed under. */
const CHUNK_DAYS = 365;
const CREDITS_PER_REQUEST = 1;
const MAX_RETRIES_PER_REQUEST = 2;

/**
 * The operator's horizon of interest. Days between this and where ownership
 * evidence begins are UNKNOWN prehistory: deliberately not requested, and
 * reported so the omission is visible rather than assumed.
 */
const HORIZON_FROM_ISO = "2020-01-01";

const MS_PER_DAY = 86_400_000;
const daysBetween = (a: string, b: string): number =>
  Math.max(0, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_PER_DAY));

async function main(): Promise<number> {
  const registry = defaultPriceRegistry();
  const valuationToISO = yesterdayUTCISO();

  console.log("╔════════════════════════════════════════════════════════════════════════╗");
  console.log("║  DRY RUN — no provider contacted, no row written, nothing scheduled    ║");
  console.log("║  Approve or refuse this report before any credits are spent.          ║");
  console.log("╚════════════════════════════════════════════════════════════════════════╝\n");
  console.log(
    `registry: ${registry.adapters.length} adapter(s)` +
    `${registry.adapters.length ? ` (${registry.adapters.map((a) => a.source).join(", ")})` : " — NO VENDOR KEY CONFIGURED"}`,
  );
  console.log(
    `valuation ceiling: ${valuationToISO} · request limit: ${CHUNK_DAYS} day(s) · ` +
    `assumed ${CREDITS_PER_REQUEST} credit/request · retry allowance ${MAX_RETRIES_PER_REQUEST}\n`,
  );

  const instruments = await db.instrument.findMany({
    select: { id: true, tickerSymbol: true, assetClass: true },
    orderBy: [{ assetClass: "asc" }, { tickerSymbol: "asc" }],
  });
  const label = new Map(instruments.map((i) => [i.id, `${(i.tickerSymbol ?? "(no ticker)").slice(0, 22).padEnd(22)} ${String(i.assetClass).padEnd(7)}`]));
  const ids = instruments.map((i) => i.id);

  // ── Ownership → coverage → plan → budget, the same chain a real run uses ──
  const ownership = await loadOwnershipWindows(ids, valuationToISO);

  const requests: Array<{ instrumentId: string; fromISO: string; toISO: string }> = [];
  const segmentsById = new Map<string, OwnershipSegment[]>();
  const unknownSkippedById = new Map<string, number>();
  const noAcquisition: Array<{ id: string; reason: string }> = [];

  for (const id of ids) {
    const own = ownership.get(id);
    if (!own || own.kind !== "resolved") {
      noAcquisition.push({ id, reason: own?.kind === "no-acquisition" ? own.reason : "UNRESOLVED" });
      continue;
    }
    segmentsById.set(id, own.segments);
    unknownSkippedById.set(id, daysBetween(HORIZON_FROM_ISO, own.acquisitionFromISO));
    requests.push({ instrumentId: id, fromISO: own.acquisitionFromISO, toISO: own.acquisitionToISO });
  }

  const coverages = requests.length
    ? await loadInstrumentCoverage(requests, { basis: PriceBasis.RAW_CLOSE, registry })
    : [];

  const budgetInputs: BudgetInput[] = [];
  const plansById = new Map<string, AcquisitionPlan>();
  let attention = 0;

  for (const coverage of coverages) {
    const plan = planAcquisition({ coverage, maxCalendarDaysPerRequest: CHUNK_DAYS });
    plansById.set(coverage.instrumentId, plan);
    if (plan.kind === "calendar-unavailable" || plan.kind === "planning-error") attention++;

    const instrument = instruments.find((i) => i.id === coverage.instrumentId)!;
    const routed = resolveProviderForInstrument(registry, {
      assetClass:     String(instrument.assetClass),
      providerSymbol: instrument.tickerSymbol ?? "",
      basis:          PriceBasis.RAW_CLOSE,
    });

    budgetInputs.push({
      plan,
      segments: segmentsById.get(coverage.instrumentId) ?? [],
      source:   routed.kind === "provider" ? routed.adapter.source : null,
      unknownSkippedDays: unknownSkippedById.get(coverage.instrumentId) ?? 0,
    });
  }

  const budget = estimateAcquisitionBudget(budgetInputs, {
    creditsPerRequest:    CREDITS_PER_REQUEST,
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
  });

  // ── Per instrument ────────────────────────────────────────────────────────
  console.log("PER INSTRUMENT\n");
  for (const b of budget.instruments) {
    const plan = plansById.get(b.instrumentId)!;
    const head = `  ${label.get(b.instrumentId) ?? b.instrumentId}`;
    if (plan.kind !== "planned") {
      const why = plan.kind === "no-op" ? plan.reason
        : plan.kind === "unavailable" ? plan.reasons.join(",")
        : plan.kind === "calendar-unavailable" ? plan.failure.code
        : plan.code;
      console.log(`${head} ${plan.kind.toUpperCase().padEnd(21)} ${why}  → 0 requests`);
      continue;
    }
    console.log(
      `${head} PLANNED  provider=${b.source ?? "NONE"} · ${b.requests} request(s) · ` +
      `${b.requestDays} day(s) · ~${b.expectedNewRows} new row(s)`,
    );
    console.log(
      `${" ".repeat(head.length)}   confidence: KNOWN ${b.knownDays}d · POSSIBLE ${b.possibleDays}d` +
      `${b.unattributedDays > 0 ? ` · ⚠ UNATTRIBUTED ${b.unattributedDays}d` : ""}` +
      ` · UNKNOWN skipped ${b.unknownSkippedDays}d`,
    );
    for (const [i, w] of plan.windows.entries()) {
      console.log(`${" ".repeat(head.length)}   [${String(i + 1).padStart(2)}] ${w.fromISO} → ${w.toISO} (${w.requestDays}d)  ${b.checkpointIds[i]}`);
    }
  }

  if (noAcquisition.length > 0) {
    console.log("\n  NO OWNERSHIP EVIDENCE (never requested):");
    for (const n of noAcquisition) console.log(`    ${label.get(n.id) ?? n.id} ${n.reason}`);
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(72));
  console.log("BUDGET");
  console.log("─".repeat(72));
  console.log(`  requests                 ${budget.totalRequests}`);
  console.log(`  request days             ${budget.totalRequestDays}`);
  console.log(`  estimated credits        ${budget.estimatedCredits}`);
  console.log(`  expected new observations ${budget.totalExpectedRows}`);
  console.log("");
  console.log(`  KNOWN coverage           ${budget.totalKnownDays} day(s)   — direct ownership evidence`);
  console.log(`  POSSIBLE coverage        ${budget.totalPossibleDays} day(s)   — inferred, must stay disclosed`);
  console.log(`  UNKNOWN skipped          ${budget.totalUnknownSkipped} day(s)   — no evidence, never requested`);
  if (budget.totalUnattributed > 0) {
    console.log(`  ⚠ UNATTRIBUTED           ${budget.totalUnattributed} day(s)   — requested outside any ownership segment`);
  }
  console.log("");
  console.log(`  worst case (${MAX_RETRIES_PER_REQUEST} retries)  ${budget.worstCaseRequests} request(s), ${budget.worstCaseCredits} credit(s)`);
  console.log("─".repeat(72));
  console.log(
    "\nRetry policy: THROTTLED and PROVIDER_ERROR are retryable on a later run;\n" +
    "INVALID_DATA and UNSUPPORTED need investigation. Checkpoints are identified by\n" +
    "(provider, instrument, requested window, chunk), so a truncated run resumes by\n" +
    "identity rather than position, and already-stored observations are never re-fetched.\n",
  );

  if (attention > 0) {
    console.error(`${attention} plan(s) need attention before execution.`);
    return 1;
  }
  console.log("dry-run-acquisition: report complete. NOTHING WAS FETCHED OR WRITTEN.");
  console.log("A live run requires explicit approval of the figures above.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("dry-run-acquisition: failed:", e);
    process.exit(2);
  });
