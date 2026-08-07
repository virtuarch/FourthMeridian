/**
 * scripts/repair-event-projection-drift.ts
 *
 * v2.6-EVENT-1 — re-derive the stored projection of every TransactionEvent whose
 * stored state disagrees with what its observations imply.
 *
 * DRY-RUN BY DEFAULT. `--apply` is required to write anything, and the write is a
 * SINGLE TRANSACTION: every event lands together or none does.
 *
 * ── What went stale, and why ────────────────────────────────────────────────
 *
 * `lib/plaid/syncTransactions.ts` tombstones rows Plaid reports in `removed[]`
 * (soft delete, `deletedAt`). `projectEvent` derives `WITHDRAWN` when no
 * observation still points at a LIVE row — that is precisely how a pending
 * authorization the provider took back becomes visible as such. But the tombstone
 * path never re-projected the events it had just invalidated, so the stored
 * lifecycle kept saying `PENDING` about a row that no longer exists.
 *
 * The write path is fixed in the same slice; this repairs the rows that drifted
 * before it was.
 *
 * ── What it writes, and nothing else ────────────────────────────────────────
 *
 * ONLY the nine projection columns on `TransactionEvent`, and only by calling the
 * SAME `reprojectEvent` the ingest path calls. There is no second derivation here
 * — the repair cannot disagree with the write path, because it IS the write path.
 *
 * ⚠️ It creates no event, deletes no event, and touches no `TransactionObservation`
 * and no `Transaction`. Observations are the RECORD; a projection is a FUNCTION of
 * them. Repairing the function's output must never edit its input — that would
 * destroy the evidence that makes the projection re-derivable, which is the whole
 * point of the L8 spine.
 *
 * ── Pre-flight refusals (each stops the run entirely) ───────────────────────
 *
 *  1. any drifting event has ZERO observations (nothing to re-derive from)
 *  2. any drifting event's economicDate would MOVE (economic date is pinned to
 *     the FIRST observation and must never move on a projection repair —
 *     v2.6-L8; a drift here means something other than liveness changed)
 *  3. the observation count would change (the input set is not ours to alter)
 *
 * ── Fingerprints ────────────────────────────────────────────────────────────
 *
 * Two are printed before and after. FINANCIAL must NOT move — a projection is a
 * lifecycle fact, not a money fact, and no total may shift. PROJECTION is
 * expected to move, exactly once, by exactly the reported set.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/repair-event-projection-drift.ts
 *   npx tsx --env-file=.env.local scripts/repair-event-projection-drift.ts --apply
 */

import { createHash } from "node:crypto";

import { db } from "@/lib/db";
import { projectEvent, type ObservationFacts } from "@/lib/transactions/event-identity";
import { reprojectEvent } from "@/lib/transactions/event-write";

const APPLY = process.argv.includes("--apply");
const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const iso = (d: Date | null) => (d ? d.toISOString() : "null");

/**
 * FINANCIAL — every figure a surface could show. Must not move.
 *
 * Deliberately spans the Transaction table, not just the events: the claim being
 * proven is "no money moved anywhere", and a fingerprint over the rows the repair
 * targets could not detect collateral damage elsewhere.
 */
async function financialFingerprint(): Promise<string> {
  const rows = await db.transaction.findMany({
    where:   { deletedAt: null },
    select:  { id: true, amount: true, economicDate: true, date: true, flowType: true, deletedAt: true },
    orderBy: { id: "asc" },
  });
  const h = createHash("sha256");
  for (const r of rows) {
    h.update(`${r.id}|${r.amount}|${iso(r.economicDate)}|${iso(r.date)}|${r.flowType ?? ""}|${iso(r.deletedAt)}\n`);
  }
  return `${h.digest("hex").slice(0, 16)}  (${rows.length} live rows)`;
}

/** PROJECTION — the event state this repair exists to correct. Expected to move. */
async function projectionFingerprint(): Promise<string> {
  const rows = await db.transactionEvent.findMany({
    select:  { id: true, lifecycle: true, currentAmount: true, currentTransactionId: true, observationCount: true, economicDate: true },
    orderBy: { id: "asc" },
  });
  const h = createHash("sha256");
  for (const e of rows) {
    h.update(`${e.id}|${e.lifecycle}|${e.currentAmount}|${e.currentTransactionId ?? ""}|${e.observationCount}|${iso(e.economicDate)}\n`);
  }
  return `${h.digest("hex").slice(0, 16)}  (${rows.length} events)`;
}

interface Drift {
  eventId:  string;
  stored:   { lifecycle: string; currentAmount: number; currentTransactionId: string | null; observationCount: number; economicDate: Date };
  derived:  ReturnType<typeof projectEvent>;
  obsCount: number;
}

/** Every event whose stored projection disagrees with its observations. */
async function findDrift(): Promise<Drift[]> {
  const events = await db.transactionEvent.findMany({
    select: {
      id: true, lifecycle: true, currentAmount: true, currentTransactionId: true,
      observationCount: true, economicDate: true,
    },
  });
  const observations = await db.transactionObservation.findMany({
    select: { eventId: true, observedAt: true, lifecycle: true, amount: true, postingDate: true, economicDate: true, transactionId: true },
  });
  const txIds = [...new Set(observations.map((o) => o.transactionId).filter((x): x is string => x != null))];
  const live = new Set(
    (await db.transaction.findMany({ where: { id: { in: txIds }, deletedAt: null }, select: { id: true } })).map((r) => r.id),
  );

  const byEvent = new Map<string, typeof observations>();
  for (const o of observations) {
    const list = byEvent.get(o.eventId) ?? [];
    list.push(o);
    byEvent.set(o.eventId, list);
  }

  const out: Drift[] = [];
  for (const e of events) {
    const os = byEvent.get(e.id) ?? [];
    if (os.length === 0) {
      // Refusal 1 is raised in main() — recorded here so it is visible, not skipped.
      out.push({ eventId: e.id, stored: e, derived: null as never, obsCount: 0 });
      continue;
    }
    const facts: ObservationFacts[] = os.map((o) => ({
      observedAt:   o.observedAt,
      lifecycle:    o.lifecycle as "PENDING" | "POSTED",
      amount:       o.amount,
      postingDate:  o.postingDate,
      economicDate: o.economicDate,
      liveTransactionId: o.transactionId && live.has(o.transactionId) ? o.transactionId : null,
    }));
    const p = projectEvent(facts);
    const same =
      p.lifecycle === e.lifecycle &&
      p.economicDate.toISOString() === e.economicDate.toISOString() &&
      Math.abs(p.currentAmount - e.currentAmount) < 0.005 &&
      (p.currentTransactionId ?? null) === (e.currentTransactionId ?? null) &&
      p.observationCount === e.observationCount;
    if (!same) out.push({ eventId: e.id, stored: e, derived: p, obsCount: os.length });
  }
  return out;
}

async function main(): Promise<void> {
  console.log(`\n[REPAIR] event projection drift — ${APPLY ? "APPLY" : "DRY RUN"}`);

  const finBefore  = await financialFingerprint();
  const projBefore = await projectionFingerprint();
  console.log(`  FINANCIAL  fingerprint (before): ${finBefore}`);
  console.log(`  PROJECTION fingerprint (before): ${projBefore}`);

  const drift = await findDrift();

  bar(`DRIFTING EVENTS — ${drift.length}`);
  if (drift.length === 0) {
    console.log("  none. Every stored projection already equals its derived projection. ✓\n");
    return;
  }

  // ── Pre-flight refusals ───────────────────────────────────────────────────
  const orphaned = drift.filter((d) => d.obsCount === 0);
  if (orphaned.length > 0) {
    console.error(`\n  ✗ REFUSED — ${orphaned.length} drifting event(s) have ZERO observations.`);
    console.error(`    A projection is a function of observations; with none there is nothing to`);
    console.error(`    re-derive from, and inventing a state would be fabrication.`);
    for (const d of orphaned.slice(0, 5)) console.error(`      ${d.eventId}`);
    process.exitCode = 1;
    return;
  }

  const econMoved = drift.filter((d) => d.derived.economicDate.toISOString() !== d.stored.economicDate.toISOString());
  if (econMoved.length > 0) {
    console.error(`\n  ✗ REFUSED — ${econMoved.length} event(s) would have their economicDate MOVED.`);
    console.error(`    The economic date is pinned to the FIRST observation and must never move`);
    console.error(`    (v2.6-L8). A drift here is not a liveness change and this repair is the`);
    console.error(`    wrong tool for it.`);
    for (const d of econMoved.slice(0, 5)) {
      console.error(`      ${d.eventId}: ${iso(d.stored.economicDate)} → ${iso(d.derived.economicDate)}`);
    }
    process.exitCode = 1;
    return;
  }

  const countMoved = drift.filter((d) => d.derived.observationCount !== d.stored.observationCount);
  if (countMoved.length > 0) {
    console.error(`\n  ✗ REFUSED — ${countMoved.length} event(s) would change observationCount.`);
    console.error(`    The observation set is the INPUT. A projection repair does not alter it.`);
    for (const d of countMoved.slice(0, 5)) {
      console.error(`      ${d.eventId}: ${d.stored.observationCount} → ${d.derived.observationCount}`);
    }
    process.exitCode = 1;
    return;
  }

  // ── The roll call ─────────────────────────────────────────────────────────
  for (const d of drift) {
    console.log(`\n  ${d.eventId}   (${d.obsCount} observation${d.obsCount === 1 ? "" : "s"})`);
    if (d.derived.lifecycle !== d.stored.lifecycle) {
      console.log(`      lifecycle            ${d.stored.lifecycle} → ${d.derived.lifecycle}`);
    }
    if (Math.abs(d.derived.currentAmount - d.stored.currentAmount) >= 0.005) {
      console.log(`      currentAmount        ${d.stored.currentAmount} → ${d.derived.currentAmount}`);
    }
    if ((d.derived.currentTransactionId ?? null) !== (d.stored.currentTransactionId ?? null)) {
      console.log(`      currentTransactionId ${d.stored.currentTransactionId ?? "null"} → ${d.derived.currentTransactionId ?? "null"}`);
    }
  }

  const toWithdrawn = drift.filter((d) => d.derived.lifecycle === "WITHDRAWN" && d.stored.lifecycle !== "WITHDRAWN");
  console.log(`\n  of these, ${toWithdrawn.length} become WITHDRAWN — the tombstoned-pending shape this slice fixes.`);

  if (!APPLY) {
    console.log(`\n  DRY RUN — nothing written. Re-run with --apply to repair.\n`);
    return;
  }

  // ── The write ─────────────────────────────────────────────────────────────
  // One transaction, and the SAME reprojectEvent the ingest path calls. If this
  // module's derivation ever changed, the repair would change with it — by
  // construction, not by remembering to.
  await db.$transaction(async (tx) => {
    for (const d of drift) await reprojectEvent(tx, d.eventId);
  });

  const finAfter  = await financialFingerprint();
  const projAfter = await projectionFingerprint();
  bar("VERDICT");
  console.log(`  FINANCIAL  fingerprint (after) : ${finAfter}`);
  console.log(`  PROJECTION fingerprint (after) : ${projAfter}`);

  const finHeld    = finAfter === finBefore;
  const projMoved  = projAfter !== projBefore;
  console.log(`\n  ${finHeld  ? "✓" : "✗"} FINANCIAL fingerprint ${finHeld ? "held" : "MOVED — a projection repair must not move money"}`);
  console.log(`  ${projMoved ? "✓" : "✗"} PROJECTION fingerprint ${projMoved ? "moved, as intended" : "did NOT move — the repair wrote nothing"}`);

  const residual = await findDrift();
  console.log(`  ${residual.length === 0 ? "✓" : "✗"} residual drift after repair: ${residual.length}`);

  if (!finHeld || !projMoved || residual.length > 0) process.exitCode = 1;
  else console.log(`\n  [REPAIR] ${drift.length} event(s) re-projected. ✓\n`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => { console.error(e); await db.$disconnect(); process.exitCode = 1; });
