/**
 * lib/crypto/sol-history-sync.ts
 *
 * W-M2 — native SOL historical reconstruction: orchestration + persistence.
 *
 * Acquires an owner address's native SOL movement history, reconciles it against
 * an independently observed balance, replays it through THE canonical quantity
 * engine, and writes the reconstructed quantities onto the canonical position
 * spine as `PositionObservation(origin: DERIVED)`.
 *
 * It builds no replay engine, no valuation, no second read model. The whole of
 * this file is glue between an adapter and authorities that already exist.
 *
 * ── WHY NO `Transaction` ROWS ARE WRITTEN — A DEVIATION, STATED ──────────────
 * The approved plan permitted reusing `Transaction` for SOL movements "as BTC
 * does", while forbidding fabricated bank semantics: no merchant, no
 * income/spend classification, no counterparty type.
 *
 * Those two instructions cannot both be satisfied. `Transaction.merchant` is
 * `String` and `Transaction.category` is `TransactionCategory` — both NOT NULL.
 * Writing a chain movement into that model REQUIRES inventing a merchant name
 * and choosing an income/spend category for an event that has neither. Bitcoin
 * does exactly that today (`merchant: "Bitcoin received"`, `category: Income`),
 * and the architecture investigation measured the result: all 28 live BTC rows
 * are byte-identical bank rows with every genuine banking field null, and the
 * income taxonomy had to be defended against them.
 *
 * So this slice takes the third option, which needs no schema change and
 * fabricates nothing: MOVEMENTS ARE NOT PERSISTED AT ALL. They are acquired,
 * reconciled and replayed in memory, and what is persisted is the RESULT — the
 * reconstructed quantities, on the position spine where quantities belong.
 *
 * Nothing downstream needs the rows: the replay consumes
 * `NormalizedQuantityEvent`s built directly from `ChainMovement`s, and the
 * reconciliation compares integers. The only cost is that a full historical run
 * re-fetches rather than resuming from stored rows — bounded by the page budget,
 * resumable by cursor, and honest.
 *
 * DELETION / MIGRATION CONDITION for this decision: when a dedicated canonical
 * crypto-movement table exists (integer base units, chain event identity, no
 * bank columns), this file gains a persistence step and BTC's movements migrate
 * off `Transaction` onto the same table. Until then, no chain movement acquires
 * a fabricated merchant on this path.
 *
 * ── WHAT IS PERSISTED, AND WHAT IS NEVER OVERWRITTEN ─────────────────────────
 * `PositionObservation(origin: DERIVED, source: SOL_RECONSTRUCTION_SOURCE)`,
 * delete-and-replace scoped to exactly that (account, instrument, origin,
 * source) — the pattern `reconstruction-runner.ts` already uses. OBSERVED rows
 * are never touched, and `resolvePositionAsOf` ranks OBSERVED above DERIVED on a
 * shared date, so a reconstruction can neither delete nor outrank an observation.
 */

import { PositionOrigin } from "@prisma/client";
import { db } from "@/lib/db";
import { SOL_ASSET } from "@/lib/investments/crypto-instrument";
import { SOL_NATIVE, ledgerEpsilonFor } from "@/lib/crypto/native-asset";
import { resolveCryptoInstrumentId } from "@/lib/investments/crypto-instrument";
import {
  acquireSolHistory, EMPTY_SOL_HISTORY_CURSOR,
  type SolHistoryCursor, type SolHistoryDeps,
} from "@/lib/crypto/sol-history";
import {
  reconcileMovementsAgainstBalance, licenseCoverageByReconciliation,
  toEventStreamCompleteness, movementsToQuantityEvents, resolveMovementDisposition,
  describeCoverage,
  type ChainMovement, type ChainCoverage, type MovementDisposition,
} from "@/lib/crypto/chain-movement";
import { persistPositionCoverage } from "@/lib/crypto/position-coverage";
import {
  replayQuantityTimeline, PERMITTED_ANCHOR_ORIGINS,
  type QuantityAnchor, type QuantityTimeline,
} from "@/lib/investments/quantity-replay.core";
import { SOL_CHAIN } from "@/lib/crypto/sol-sync";

/** Provenance stamped on every DERIVED row this reconstruction writes. */
export const SOL_RECONSTRUCTION_SOURCE = "sol-reconstruction";

export type SolHistoryRefusal =
  | "NOT_A_SOL_WALLET"
  | "NO_PROVIDER_CONFIGURED"
  | "PROVIDER_FAILED"
  | "NO_OBSERVED_ANCHOR"
  | "LEDGER_DOES_NOT_RECONCILE"
  | "COVERAGE_UNLICENSED";

export interface SolHistoryResult {
  accountId: string;
  ok: boolean;
  refusal?: SolHistoryRefusal;
  reason?: string;
  coverage?: ChainCoverage;
  /** Exact integer reconciliation against the observed balance. */
  reconciliation?: { reconciles: boolean; residualLamports: string; movementCount: number };
  timeline?: QuantityTimeline;
  /** DERIVED rows written. Zero on any refusal. */
  derivedRowsWritten?: number;
  /** Per-movement disposition — EXTERNAL_OUTFLOW is as far as the chain goes. */
  dispositions?: Array<{ eventId: string; movementKey: string; disposition: MovementDisposition }>;
  cursor?: SolHistoryCursor;
}

export interface SolHistorySyncArgs {
  accountId: string;
  /** Requested window. Both ends are caller decisions — never inferred here. */
  windowFromISO: string;
  windowToISO: string;
  /** Resume checkpoint from a previous run. */
  cursor?: SolHistoryCursor;
  /** Injected movements, for deterministic offline acceptance tests. */
  movementsOverride?: readonly ChainMovement[];
  coverageOverride?: ChainCoverage;
  /** Observed balance in LAMPORTS, when the caller already holds it. */
  observedLamportsOverride?: bigint | null;
  deps?: SolHistoryDeps;
  dryRun?: boolean;
}

/**
 * Reconstruct a SOL wallet's historical native quantity.
 *
 * Never throws. Every refusal is coded and carries a reason, and a refusal
 * writes NOTHING — a wallet whose history cannot be established keeps whatever
 * it had, which for a W-M1c wallet is an honest current position and no history.
 */
export async function reconstructSolHistory(args: SolHistorySyncArgs): Promise<SolHistoryResult> {
  const { accountId } = args;

  const account = await db.financialAccount.findUnique({
    where:  { id: accountId },
    select: { id: true, ownerUserId: true, walletChain: true, walletAddress: true, deletedAt: true },
  });
  if (!account || account.deletedAt || account.walletChain !== SOL_CHAIN || !account.walletAddress) {
    return { accountId, ok: false, refusal: "NOT_A_SOL_WALLET", reason: "not a SOL wallet with an address" };
  }

  // ── 1. THE OWNED-ADDRESS SET. The ONLY evidence that may turn an outflow into
  //    an internal transfer. Read from canonical provider identity — a fact this
  //    system holds — never from an address label or an exchange list.
  const ownedRows = await db.providerAccountIdentity.findMany({
    where:  { provider: "WALLET", financialAccount: { ownerUserId: account.ownerUserId ?? "", deletedAt: null } },
    select: { externalAccountId: true },
  });
  const ownedAddresses = new Set<string>([account.walletAddress, ...ownedRows.map((r) => r.externalAccountId)]);

  // ── 2. ACQUIRE. Injected movements short-circuit the network for fixtures.
  let movements: readonly ChainMovement[];
  let coverage: ChainCoverage;
  let cursor: SolHistoryCursor = args.cursor ?? EMPTY_SOL_HISTORY_CURSOR;
  let multiAssetEventIds: ReadonlySet<string> = new Set();

  if (args.movementsOverride) {
    movements = args.movementsOverride;
    coverage = args.coverageOverride ?? {
      kind: "PARTIAL", coveredFromISO: null, coveredToISO: null,
      caveats: ["ADDRESS_INDEX_INCOMPLETE"], source: "fixture",
    };
  } else {
    try {
      const acquired = await acquireSolHistory(
        { ownerAddress: account.walletAddress, ownedAddresses, cursor }, args.deps,
      );
      movements = acquired.movements;
      coverage = acquired.coverage;
      cursor = acquired.cursor;
      multiAssetEventIds = new Set(acquired.multiAssetEventIds);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { accountId, ok: false, refusal: "PROVIDER_FAILED", reason };
    }
    if (coverage.kind === "UNKNOWN" && coverage.caveats.includes("NO_PROVIDER_CONFIGURED")) {
      // THE DARK PATH. No archival endpoint means no history — which is a
      // different fact from "this wallet has no history", and must never be
      // recorded as one. Nothing is written.
      return {
        accountId, ok: false, refusal: "NO_PROVIDER_CONFIGURED",
        reason: describeCoverage(coverage), coverage,
      };
    }
  }

  const instrumentId = await resolveCryptoInstrumentId(SOL_ASSET);

  // ── 3. ANCHORS. A replay is only ever as good as the absolute statement it
  //    inverts. Only OBSERVED/IMPORTED/USER_ASSERTED rows may anchor —
  //    PERMITTED_ANCHOR_ORIGINS excludes DERIVED so a replay can never anchor on
  //    a previous replay and compound its own error invisibly.
  const observationRows = await db.positionObservation.findMany({
    where: {
      financialAccountId: accountId, instrumentId,
      supersededById: null, deletedAt: null,
      origin: { in: [PositionOrigin.OBSERVED, PositionOrigin.IMPORTED, PositionOrigin.USER_ASSERTED] },
    },
    select: { id: true, date: true, quantity: true, origin: true, completeness: true },
    orderBy: { date: "desc" },
  });
  const anchors: QuantityAnchor[] = observationRows.map((r) => ({
    observationId:        r.id,
    dateISO:              r.date.toISOString().slice(0, 10),
    // PositionObservation.date is @db.Date, so there is no instant to state.
    // NEVER synthesise one from createdAt: that is when we wrote the row, not
    // when the holding was true.
    effectiveDateTimeISO: null,
    quantity:             r.quantity,
    origin:               String(r.origin),
    completeness:         r.completeness ?? "",
  }));

  if (anchors.length === 0) {
    return {
      accountId, ok: false, refusal: "NO_OBSERVED_ANCHOR", coverage,
      reason:
        "This wallet has no observed position to anchor a reconstruction on. Movements alone " +
        "state how the quantity CHANGED, never what it WAS — so without an absolute observation " +
        "there is no quantity to invert backward from.",
    };
  }

  // ── 4. RECONCILE, IN EXACT INTEGERS. The independently observed balance is
  //    the newest anchor, converted back to base units. Σ movements must equal
  //    it exactly, or the acquired history cannot license any other date.
  const newestAnchor = anchors.reduce((a, b) => (a.dateISO >= b.dateISO ? a : b));
  const observedLamports =
    args.observedLamportsOverride !== undefined
      ? args.observedLamportsOverride
      : BigInt(Math.round(newestAnchor.quantity * Number(BigInt(10) ** BigInt(SOL_NATIVE.decimals))));

  const recon = reconcileMovementsAgainstBalance(movements, observedLamports);
  // The licence runs to the DATE THE BALANCE WAS OBSERVED, not to the newest
  // movement: a movement in between would have broken the arithmetic, so the
  // arithmetic closing proves the interval empty. See the function's doc.
  const licensed = licenseCoverageByReconciliation(coverage, recon, newestAnchor.dateISO);

  const dispositions = movements.map((m) => ({
    eventId: m.eventId, movementKey: m.movementKey,
    disposition: resolveMovementDisposition(m, {
      ownedAddresses, multiAsset: multiAssetEventIds.has(m.eventId),
    }),
  }));

  if (!recon.reconciles) {
    // REFUSE, DO NOT FABRICATE. The wallet's CURRENT balance is still observed
    // and still true; only history is withheld.
    return {
      accountId, ok: false, refusal: "LEDGER_DOES_NOT_RECONCILE",
      reason: recon.reason, coverage: licensed, dispositions, cursor,
      reconciliation: { reconciles: false, residualLamports: recon.residual.toString(), movementCount: recon.movementCount },
    };
  }

  // ── 5. REPLAY — THE existing engine. No second implementation.
  const events = movementsToQuantityEvents(movements, {
    accountId, instrumentId, decimals: SOL_NATIVE.decimals,
  });
  const timeline = replayQuantityTimeline({
    instrumentId, accountId, anchors, events,
    windowFromISO: args.windowFromISO,
    windowToISO:   args.windowToISO,
    eventStream:   toEventStreamCompleteness(licensed),
    // One lamport, from the asset's own descriptor.
    tolerance:     ledgerEpsilonFor(SOL_NATIVE),
  });

  // ── 6. PERSIST THE RESULT. Only ABSOLUTE segments state a quantity; RELATIVE
  //    and UNRESOLVED segments state that one could not be established, and
  //    they write NOTHING. Uncovered time writes nothing — which is what keeps
  //    "before the first defensible anchor" absent rather than zero.
  const rows = derivedRowsFromTimeline(timeline);

  if (!args.dryRun) {
    await db.$transaction(async (tx) => {
      await tx.positionObservation.deleteMany({
        where: {
          financialAccountId: accountId, instrumentId,
          origin: PositionOrigin.DERIVED, source: SOL_RECONSTRUCTION_SOURCE,
        },
      });
      if (rows.length > 0) {
        await tx.positionObservation.createMany({
          data: rows.map((r) => ({
            financialAccountId: accountId,
            instrumentId,
            date:     new Date(`${r.dateISO}T00:00:00.000Z`),
            quantity: r.quantity,
            origin:   PositionOrigin.DERIVED,
            source:   SOL_RECONSTRUCTION_SOURCE,
            completeness: r.basis,
            isCash:   false,
          })),
          skipDuplicates: true,
        });
      }
      // W6b — THE LICENCE, persisted with the evidence it licenses, in the same
      // transaction. Before this the coverage was computed, used to drive the
      // replay, returned to the caller and then discarded — so every later
      // question about temporal licence was answered by row presence. Rows are
      // evidence; this is the authority to project them onto a date.
      await persistPositionCoverage(tx, accountId, instrumentId, licensed);
    });
  }

  return {
    accountId, ok: true, coverage: licensed, timeline, dispositions, cursor,
    derivedRowsWritten: rows.length,
    reconciliation: { reconciles: true, residualLamports: "0", movementCount: recon.movementCount },
  };
}

/**
 * Expand the timeline's ABSOLUTE segments into one dated row per day.
 *
 * PER-DAY RATHER THAN PER-STEP, deliberately. The read path resolves a position
 * with `nearestOnOrBefore`, which carries the latest row forward indefinitely —
 * so writing only the step boundaries would silently extend a POINT claim
 * ("this held on this date, and nothing is said about the next") into an
 * interval claim. Writing the days the timeline actually licenses keeps the
 * claim exactly as wide as the evidence, and leaves genuinely uncovered days
 * with no row at all.
 */
export function derivedRowsFromTimeline(
  timeline: QuantityTimeline,
): Array<{ dateISO: string; quantity: number; basis: string }> {
  const out: Array<{ dateISO: string; quantity: number; basis: string }> = [];
  const seen = new Set<string>();
  for (const seg of timeline.segments) {
    if (seg.kind !== "ABSOLUTE") continue;
    let d = seg.fromISO;
    // Bounded walk; both ends are ISO dates from the same engine.
    for (let guard = 0; d <= seg.toISO && guard < 4000; guard++) {
      if (!seen.has(d)) { seen.add(d); out.push({ dateISO: d, quantity: seg.quantity, basis: seg.basis }); }
      d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    }
  }
  return out.sort((a, b) => a.dateISO.localeCompare(b.dateISO));
}

/** Exported for the acceptance tests — the anchor-origin rule, as data. */
export const SOL_PERMITTED_ANCHOR_ORIGINS = PERMITTED_ANCHOR_ORIGINS;
