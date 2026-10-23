/**
 * scripts/check-quantity-replay-readiness.ts
 *
 * V26-QUANTITY-1B — replay-readiness audit. STRICTLY READ-ONLY.
 *
 *     npx dotenv -e .env.local -- npx tsx scripts/check-quantity-replay-readiness.ts
 *
 * ╔════════════════════════════════════════════════════════════════════════╗
 * ║  NO WRITES. NO PROVIDER CALLS. NO REPLAY MATERIALIZATION.              ║
 * ║  Diagnostic only — it answers "could we replay this?", never "here is  ║
 * ║  the replayed history".                                                ║
 * ╚════════════════════════════════════════════════════════════════════════╝
 *
 * ── The measure this report refuses to conflate ─────────────────────────────
 * A high share of REPLAYABLE *events* does not mean a high share of
 * reconstructible *positions*. Twenty clean BUY/SELL rows spread across ten
 * instruments — none of which has an opening anchor — is 100% replayable events
 * and 0% reconstructible positions. The two are reported separately and never
 * summed into one reassuring percentage.
 *
 * Net event delta is NOT expected to equal the latest observed quantity unless
 * an opening anchor exists AND history is complete from inception. Where it is
 * not, the difference is reported as an OPENING RESIDUE — the quantity that must
 * have existed before the first event — rather than as a mismatch.
 */

import { db } from "@/lib/db";
import {
  normalizeQuantityEvents,
  type NormalizedQuantityEvent,
} from "@/lib/investments/quantity-event.core";

/** Fractional-share tolerance. Equities settle to ~4dp locally; crypto needs more. */
const TOLERANCE = 1e-6;

type Readiness =
  | "RECONCILABLE"
  | "PARTIAL_HISTORY"
  | "UNSUPPORTED_EVENTS"
  | "UNATTRIBUTABLE_EVENTS"
  | "NO_REPLAYABLE_EVENTS"
  | "MISMATCH";

async function main(): Promise<number> {
  const beforeEvents = await db.investmentEvent.count();
  const beforePos    = await db.positionObservation.count();

  console.log("╔════════════════════════════════════════════════════════════════════════╗");
  console.log("║  REPLAY-READINESS AUDIT — read-only, no writes, no provider calls      ║");
  console.log("╚════════════════════════════════════════════════════════════════════════╝\n");

  // ── Normalize the whole corpus ────────────────────────────────────────────
  const raw = await db.investmentEvent.findMany({
    select: { id:true, financialAccountId:true, instrumentId:true, type:true, date:true, datetime:true,
              quantity:true, ratio:true, source:true, externalEventId:true, relatedInstrumentId:true,
              deletedAt:true, supersededById:true },
  });
  const audit = normalizeQuantityEvents(raw.map((r) => ({
    id: r.id, financialAccountId: r.financialAccountId, instrumentId: r.instrumentId,
    type: r.type, dateISO: r.date.toISOString().slice(0, 10),
    datetimeISO: r.datetime ? r.datetime.toISOString() : null,
    quantity: r.quantity, ratio: r.ratio, source: r.source,
    externalEventId: r.externalEventId, relatedInstrumentId: r.relatedInstrumentId,
    deletedAt: r.deletedAt, supersededById: r.supersededById,
  })));

  console.log("EVENT-LEVEL READINESS");
  console.log("─".repeat(72));
  console.log(`  total active events        ${audit.totalInput - audit.excludedInactive}`);
  console.log(`  excluded inactive          ${audit.excludedInactive}`);
  console.log(`  excluded duplicate         ${audit.excludedDuplicate}`);
  for (const [k, v] of Object.entries(audit.byStatus)) {
    console.log(`  ${k.padEnd(26)} ${v}`);
  }
  const known = audit.events.filter((e) => e.order.certainty === "KNOWN").length;
  console.log(`  ordering KNOWN             ${known}`);
  console.log(`  ordering TIE_BROKEN        ${audit.events.length - known}`);
  console.log(`  same-day collision groups  ${audit.collisionGroups}`);
  console.log(`    with known chronology    ${audit.collisionGroupsWithKnownOrder}`);
  console.log(`    with UNCERTAIN order     ${audit.collisionGroups - audit.collisionGroupsWithKnownOrder}`);
  console.log(`  operator XOR violations    ${audit.operatorInvariantViolations}` +
    (audit.operatorInvariantViolations === 0 ? "  ✓" : "  ✗ INVARIANT BROKEN"));
  const silentlyDropped = (audit.totalInput - audit.excludedInactive - audit.excludedDuplicate) - audit.events.length;
  console.log(`  silently dropped           ${silentlyDropped}` + (silentlyDropped === 0 ? "  ✓" : "  ✗"));

  // ── Per (account, instrument) ─────────────────────────────────────────────
  const byPair = new Map<string, NormalizedQuantityEvent[]>();
  for (const e of audit.events) {
    const k = `${e.accountId}|${e.instrumentId ?? "null"}`;
    (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(e);
  }

  const positions = await db.positionObservation.findMany({
    where: { deletedAt: null, supersededById: null },
    select: { financialAccountId:true, instrumentId:true, date:true, quantity:true,
              instrument:{ select:{ tickerSymbol:true } }, financialAccount:{ select:{ name:true } } },
    orderBy: { date: "asc" },
  });
  const posByPair = new Map<string, typeof positions>();
  for (const p of positions) {
    const k = `${p.financialAccountId}|${p.instrumentId}`;
    (posByPair.get(k) ?? posByPair.set(k, []).get(k)!).push(p);
  }

  const allPairs = new Set([...byPair.keys(), ...posByPair.keys()]);
  const tally: Record<Readiness, number> = {
    RECONCILABLE: 0, PARTIAL_HISTORY: 0, UNSUPPORTED_EVENTS: 0,
    UNATTRIBUTABLE_EVENTS: 0, NO_REPLAYABLE_EVENTS: 0, MISMATCH: 0,
  };
  let blockedByTransfers = 0, needOpeningBalance = 0;

  console.log("\n\nPER (ACCOUNT, INSTRUMENT)");
  console.log("─".repeat(72));
  const rows: string[] = [];

  for (const key of [...allPairs].sort()) {
    const evs = byPair.get(key) ?? [];
    const pos = posByPair.get(key) ?? [];
    const label = pos[0]
      ? `${(pos[0].financialAccount.name ?? "?").slice(0, 14).padEnd(14)} ${(pos[0].instrument.tickerSymbol ?? "(none)").padEnd(20)}`
      : `${"(no positions)".padEnd(14)} ${key.split("|")[1].slice(0, 20).padEnd(20)}`;

    const repl = evs.filter((e) => e.status === "REPLAYABLE");
    const sum = (t: string, sign: 1 | -1) =>
      repl.filter((e) => e.sourceType === t).reduce((n, e) => n + (e.normalizedDelta ?? 0), 0) * sign;
    const buys  = sum("BUY", 1);
    const sells = sum("SELL", 1);
    const ratioEvents = repl.filter((e) => e.ratio !== null).length;
    const netDelta = repl.reduce((n, e) => n + (e.normalizedDelta ?? 0), 0);

    const unsupported    = evs.filter((e) => e.status === "UNSUPPORTED_SEMANTICS");
    const unattributable = evs.filter((e) => e.status === "UNATTRIBUTABLE");
    const invalid        = evs.filter((e) => e.status === "INVALID");
    const transferBlocked = unsupported.some((e) => e.sourceType.startsWith("TRANSFER_"));

    const firstObs = pos[0]?.quantity ?? null;
    const lastObs  = pos.length ? pos[pos.length - 1].quantity : null;
    const lastObsDate = pos.length ? pos[pos.length - 1].date.toISOString().slice(0, 10) : "—";
    const firstEvtDate = repl.length ? repl[0].dateISO : "—";
    const lastEvtDate  = repl.length ? repl[repl.length - 1].dateISO : "—";

    // An opening anchor must be dated STRICTLY BEFORE the first replayable event.
    // An observation dated ON the event day is an END-of-day state that already
    // reflects that event — using it as the opening double-counts (APLD: a same-day
    // buy of 3 against a same-day observation of 3 "reconciles" to 6).
    const anchorRow = repl.length
      ? [...pos].reverse().find((p) => p.date.toISOString().slice(0, 10) < repl[0].dateISO)
      : undefined;
    const hasOpeningAnchor = anchorRow !== undefined;
    const openingQty = anchorRow?.quantity ?? null;

    // RECONCILIATION, stated correctly: opening + Σdelta should equal the latest
    // observation. Comparing Σdelta to the observation directly (residue vs 0)
    // would flag every correctly-closed position as a mismatch — SPCE held 1,
    // sold 1, ended 0, and Σdelta of −1 is exactly right.
    //
    // WITHOUT an anchor the residue is not an error at all: it is the quantity
    // that must have been held before recorded history began, which is precisely
    // what PARTIAL_HISTORY means.
    const residue = lastObs === null ? null
      : hasOpeningAnchor ? lastObs - ((openingQty ?? 0) + netDelta)
      : lastObs - netDelta;

    let readiness: Readiness;
    let blocker = "";
    if (unattributable.length > 0)      { readiness = "UNATTRIBUTABLE_EVENTS"; blocker = "NO_INSTRUMENT"; }
    else if (repl.length === 0)         { readiness = "NO_REPLAYABLE_EVENTS"; blocker = evs.length ? "all events neutral/unsupported" : "observations only"; }
    else if (unsupported.length > 0 || invalid.length > 0) {
      readiness = "UNSUPPORTED_EVENTS";
      blocker = [...new Set([...unsupported, ...invalid].map((e) => e.reason))].join(",");
    }
    else if (!hasOpeningAnchor)         { readiness = "PARTIAL_HISTORY"; blocker = "NO_OPENING_ANCHOR"; }
    else if (residue !== null && Math.abs(residue) > TOLERANCE) {
      readiness = "MISMATCH";
      blocker = `opening ${openingQty ?? 0} + net ${netDelta.toFixed(4)} ≠ observed ${lastObs}`;
    }
    else                                { readiness = "RECONCILABLE"; }

    tally[readiness]++;
    if (transferBlocked) blockedByTransfers++;
    if (!hasOpeningAnchor && repl.length > 0) needOpeningBalance++;

    rows.push(
      `  ${label} ${readiness.padEnd(22)} ` +
      `buys ${buys.toFixed(4).padStart(9)} sells ${sells.toFixed(4).padStart(10)} ratio ${ratioEvents} ` +
      `net ${netDelta.toFixed(4).padStart(10)} | obs first ${String(firstObs ?? "—").padStart(8)} last ${String(lastObs ?? "—").padStart(8)} @${lastObsDate} ` +
      `| evt ${firstEvtDate}→${lastEvtDate} | anchor ${hasOpeningAnchor ? String(openingQty) : "N"} ` +
      `| residue ${residue === null ? "—" : residue.toFixed(4)}${blocker ? ` | ${blocker}` : ""}`,
    );
  }
  for (const r of rows) console.log(r);

  console.log("\n\nPAIR-LEVEL READINESS");
  console.log("─".repeat(72));
  console.log(`  pairs total                          ${allPairs.size}`);
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(36)} ${v}`);
  console.log(`  blocked by unresolved transfers      ${blockedByTransfers}`);
  console.log(`  requiring opening-balance recon.     ${needOpeningBalance}`);

  console.log("\n" + "─".repeat(72));
  console.log(
    `EVENT readiness ${audit.byStatus.REPLAYABLE}/${audit.events.length} replayable — ` +
    `PAIR readiness ${tally.RECONCILABLE}/${allPairs.size} reconcilable.`);
  console.log("These are DIFFERENT measures. A replayable event does not imply a");
  console.log("reconstructible position: without an opening anchor, a perfect event");
  console.log("stream still cannot say what was held before it began.");

  // ── Read-only guard ───────────────────────────────────────────────────────
  const afterEvents = await db.investmentEvent.count();
  const afterPos    = await db.positionObservation.count();
  console.log("\n" + "─".repeat(72));
  if (afterEvents !== beforeEvents || afterPos !== beforePos) {
    console.error(`✗ WRITE DETECTED — events ${beforeEvents}→${afterEvents}, positions ${beforePos}→${afterPos}`);
    return 2;
  }
  console.log(`✓ read-only verified: events ${afterEvents} unchanged · positions ${afterPos} unchanged`);
  return audit.operatorInvariantViolations === 0 && silentlyDropped === 0 ? 0 : 1;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => { console.error("check-quantity-replay-readiness failed:", e); process.exit(2); });
