/**
 * scripts/repair-event-identity-adoption-artifacts.ts   (v2.6-EVENT-2)
 *
 * DRY-RUN BY DEFAULT. `--apply` is required to write anything.
 *
 * Repairs the live-data residue of the fingerprint-adoption defect that
 * v2.6-EVENT-2 fixed in the write path. It repairs ONLY that residue; the write
 * path fixes (the pending-ref guard and both-sides reprojection) are what stop
 * it recurring, and they landed first, deliberately.
 *
 * ── What went wrong, and what it left behind ────────────────────────────────
 *
 * `syncTransactions` path 2 adopted an existing row for a NEW Plaid
 * `transaction_id`, OVERWRITING `plaidTransactionId`, then recorded a second
 * observation under the new id. The earlier observation kept the OLD provider id
 * — an id no row carries any more. Measured on the dev corpus: 2 such
 * observations out of 4,505.
 *
 * ── The repair criterion (objective, narrow, checkable) ─────────────────────
 *
 * An ADOPTION ARTIFACT is an observation where BOTH hold:
 *   (a) its `providerRowId` is carried by NO transaction in the corpus, and
 *   (b) the transaction it points at carries a DIFFERENT `providerRowId`.
 *
 * (a) alone is not enough — a hard-deleted row would look the same. (b) is what
 * makes it an adoption: the row is present and answers to another id.
 *
 * ⚠️ FINANCIAL FINGERPRINTS ARE PRESERVED. No `Transaction` row is created,
 * deleted, tombstoned or edited. No amount, date, economicDate, flowType,
 * category or account changes. This touches ONLY the L8 identity tables
 * (`TransactionObservation`, `TransactionEvent`), and the script fails loudly if
 * a transaction-level fingerprint moves.
 *
 * ⚠️ `TransactionObservation` has no soft-delete column, so removing an artifact
 * is a hard delete. That is why every candidate is printed in full, with its
 * provider payload, before anything is written — the printed record IS the
 * forensic copy.
 *
 * ⚠️ (a) ∧ (b) IS NOT SUFFICIENT ON ITS OWN, and a later run proved it. A
 * legitimate DF-4 re-key produces exactly this signature and breaks nothing, so
 * the script additionally requires the artifact's EVENT to be broken — a stale
 * projection, or an observation sitting on an event its row does not belong to.
 * Benign re-key history is listed and KEPT. Deleting it would destroy provider
 * history to no purpose.
 *
 * ── Idempotence ────────────────────────────────────────────────────────────
 *
 * Re-running deletes nothing: the repaired events are no longer broken, so their
 * artifacts (if any) fall outside the narrowed predicate.
 *
 * Run:  npx tsx --env-file=.env.local scripts/repair-event-identity-adoption-artifacts.ts
 * Apply: … same … --apply
 */

import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { projectEvent, type ObservationFacts } from "@/lib/transactions/event-identity";
import { reprojectEvent } from "@/lib/transactions/event-write";

const APPLY = process.argv.includes("--apply");
const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

/** A fingerprint over every financial fact this script must NOT move. */
async function financialFingerprint(): Promise<{ hash: string; rows: number }> {
  const rows = await db.transaction.findMany({
    select: { id: true, amount: true, date: true, economicDate: true, deletedAt: true,
              flowType: true, category: true, financialAccountId: true, plaidTransactionId: true },
    orderBy: { id: "asc" },
  });
  const payload = rows.map((r) =>
    [r.id, r.amount, r.date.toISOString(), r.economicDate?.toISOString() ?? "", r.deletedAt ? "DEL" : "LIVE",
     r.flowType ?? "", r.category ?? "", r.financialAccountId ?? "", r.plaidTransactionId ?? ""].join("|"),
  ).join("\n");
  return { hash: createHash("sha256").update(payload).digest("hex").slice(0, 16), rows: rows.length };
}

async function main(): Promise<void> {
  console.log(`\n[REPAIR] event-identity adoption artifacts — ${APPLY ? "APPLY" : "DRY RUN"}`);

  const before = await financialFingerprint();
  console.log(`  financial fingerprint BEFORE : ${before.hash}  (${before.rows} rows)`);

  // ── 1. Find the artifacts ────────────────────────────────────────────────
  bar("1. ADOPTION ARTIFACTS");
  const artifacts: Array<{
    obs: string; prov: string; evid: string; txid: string; txplaid: string;
    lifecycle: string; amount: number; postingDate: Date; economicDate: Date; observedAt: Date;
  }> = await db.$queryRawUnsafe(`
    SELECT o.id AS obs, o."providerRowId" AS prov, o."eventId" AS evid, o."transactionId" AS txid,
           t."plaidTransactionId" AS txplaid, o.lifecycle::text AS lifecycle, o.amount,
           o."postingDate", o."economicDate", o."observedAt"
    FROM "TransactionObservation" o
    JOIN "Transaction" t ON t.id = o."transactionId"
    WHERE o."providerRowId" IS NOT NULL
      AND t."plaidTransactionId" IS NOT NULL
      AND o."providerRowId" <> t."plaidTransactionId"
      AND NOT EXISTS (SELECT 1 FROM "Transaction" x WHERE x."plaidTransactionId" = o."providerRowId")
    ORDER BY o."createdAt"`);

  if (artifacts.length === 0) {
    console.log("  none — nothing to repair (this is the post-repair steady state).");
  }
  for (const a of artifacts) {
    console.log(`\n  observation ${a.obs}`);
    console.log(`    orphaned providerRowId : ${a.prov}`);
    console.log(`    row it points at       : ${a.txid}  (now carries ${a.txplaid})`);
    console.log(`    event                  : ${a.evid}`);
    console.log(`    payload                : ${a.lifecycle} ${a.amount} posting=${a.postingDate.toISOString().slice(0, 10)} economic=${a.economicDate.toISOString().slice(0, 10)} observedAt=${a.observedAt.toISOString()}`);
    console.log(`    ⚠️ FORENSIC RECORD — this line is the only copy once deleted.`);
  }

  // ── 2. Events needing re-derivation ──────────────────────────────────────
  bar("2. EVENTS WHOSE STORED PROJECTION ≠ DERIVED (before repair)");
  const liveIds = new Set(
    (await db.transaction.findMany({ where: { deletedAt: null }, select: { id: true } })).map((r) => r.id),
  );
  const events = await db.transactionEvent.findMany({
    select: {
      id: true, lifecycle: true, economicDate: true, currentAmount: true,
      currentTransactionId: true, observationCount: true,
      observations: {
        select: { id: true, observedAt: true, lifecycle: true, amount: true, postingDate: true, economicDate: true, transactionId: true },
        orderBy: { observedAt: "asc" },
      },
    },
  });

  // ⚠️ NARROWING — an orphaned provider id is NOT on its own a defect.
  //
  // A legitimate DF-4 re-key produces exactly this signature: Plaid issues a new
  // `transaction_id` for a row we already hold, the sync adopts the row rather
  // than duplicating it, and the older provider id is left carried by nothing.
  // That is honest history and it breaks no invariant — INV-4 counts DISTINCT
  // live rows (v2.6-EVENT-2), so one row observed twice is fine.
  //
  // The DEFECT signature is narrower: the artifact's event must ALSO be broken —
  // its stored projection disagrees with its observations, or an observation sits
  // on an event its row does not belong to. Deleting anything else would destroy
  // provider history to no purpose, which this repair explicitly must not do.
  const allObs = await db.transactionObservation.findMany({
    select: { id: true, eventId: true, transactionId: true },
  });
  const txEvent = new Map(
    (await db.transaction.findMany({ select: { id: true, transactionEventId: true } }))
      .map((t) => [t.id, t.transactionEventId]),
  );
  const fkDriftedEvents = new Set(
    allObs.filter((o) => o.transactionId && txEvent.get(o.transactionId) !== undefined &&
      txEvent.get(o.transactionId) !== null && txEvent.get(o.transactionId) !== o.eventId)
      .flatMap((o) => [o.eventId, txEvent.get(o.transactionId!)!]),
  );

  const artifactIds = new Set(artifacts.map((a) => a.obs));

  /** Derive an event's projection, optionally pretending the artifacts are gone. */
  function derive(ev: (typeof events)[number], dropArtifacts: boolean) {
    const obs = ev.observations.filter((o) => !(dropArtifacts && artifactIds.has(o.id)));
    if (obs.length === 0) return null;
    const facts: ObservationFacts[] = obs.map((o) => ({
      observedAt: o.observedAt, lifecycle: o.lifecycle as "PENDING" | "POSTED", amount: o.amount,
      postingDate: o.postingDate, economicDate: o.economicDate,
      liveTransactionId: o.transactionId && liveIds.has(o.transactionId) ? o.transactionId : null,
    }));
    return projectEvent(facts);
  }

  const staleNow = events.filter((ev) => {
    const p = derive(ev, false);
    return p && (p.lifecycle !== ev.lifecycle || p.observationCount !== ev.observationCount ||
      (p.currentTransactionId ?? null) !== (ev.currentTransactionId ?? null) ||
      p.economicDate.toISOString().slice(0, 10) !== ev.economicDate.toISOString().slice(0, 10));
  });
  console.log(`  stale events : ${staleNow.length}`);
  for (const ev of staleNow) {
    const p = derive(ev, false)!;
    console.log(`    ${ev.id}`);
    console.log(`       stored  : ${ev.lifecycle} · obs=${ev.observationCount} · currentTx=${ev.currentTransactionId ?? "null"} · eco=${ev.economicDate.toISOString().slice(0, 10)}`);
    console.log(`       derived : ${p.lifecycle} · obs=${p.observationCount} · currentTx=${p.currentTransactionId ?? "null"} · eco=${p.economicDate.toISOString().slice(0, 10)}`);
  }

  // ── 3. The plan ──────────────────────────────────────────────────────────
  bar("3. PLAN");
  // Only artifacts on a BROKEN event are deleted (see the narrowing above).
  const brokenEventIds = new Set<string>([...staleNow.map((e) => e.id), ...fkDriftedEvents]);
  const benign = artifacts.filter((a) => !brokenEventIds.has(a.evid));
  const deletable = artifacts.filter((a) => brokenEventIds.has(a.evid));
  artifactIds.clear();
  for (const a of deletable) artifactIds.add(a.obs);

  if (benign.length > 0) {
    console.log(`  KEEPING ${benign.length} orphaned-provider-id observation(s) — legitimate DF-4`);
    console.log(`  re-key history on events that break no invariant:`);
    for (const a of benign) console.log(`    ${a.obs}  (event ${a.evid})`);
  }
  const touchedEventIds = new Set<string>([...deletable.map((a) => a.evid), ...staleNow.map((e) => e.id)]);
  console.log(`  DELETE ${deletable.length} adoption-artifact observation(s)`);
  console.log(`  REPROJECT ${touchedEventIds.size} event(s) from their surviving observations`);
  console.log(`\n  Projected end state per event:`);
  for (const id of touchedEventIds) {
    const ev = events.find((e) => e.id === id);
    if (!ev) continue;
    const after = derive(ev, true);
    if (!after) {
      console.log(`    ${id}  ⚠️ would have ZERO observations left — REFUSING (see abort below)`);
      continue;
    }
    console.log(`    ${id}`);
    console.log(`       from : ${ev.lifecycle} · obs=${ev.observationCount} · currentTx=${ev.currentTransactionId ?? "null"} · eco=${ev.economicDate.toISOString().slice(0, 10)}`);
    console.log(`       to   : ${after.lifecycle} · obs=${after.observationCount} · currentTx=${after.currentTransactionId ?? "null"} · eco=${after.economicDate.toISOString().slice(0, 10)}`);
  }

  // ── 4. Shape guards — abort rather than write something unexpected ───────
  bar("4. SHAPE GUARDS");
  let abort = false;
  const guard = (label: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) abort = true;
  };
  guard("deletable artifact count is within the measured blast radius (≤ 4)", deletable.length <= 4, `${deletable.length}`);
  guard("stale-event count is within the measured blast radius (≤ 4)", staleNow.length <= 4, `${staleNow.length}`);
  guard("no event would be left with zero observations",
    [...touchedEventIds].every((id) => {
      const ev = events.find((e) => e.id === id);
      return !ev || derive(ev, true) !== null;
    }));
  guard("no artifact is the ONLY observation of its transaction",
    deletable.every((a) => events.some((e) => e.observations.some((o) =>
      o.transactionId === a.txid && !artifactIds.has(o.id)))));
  guard("every artifact's transaction is still LIVE (we are not resurrecting history)",
    deletable.every((a) => liveIds.has(a.txid)));

  if (abort) {
    console.log(`\n  ⚠️ ABORTING — the corpus does not match the shape this repair was written for.`);
    await db.$disconnect();
    process.exitCode = 1;
    return;
  }

  // ── 5. Apply ─────────────────────────────────────────────────────────────
  bar(APPLY ? "5. APPLYING" : "5. DRY RUN — NOTHING WRITTEN");
  if (!APPLY) {
    console.log(`  Re-run with --apply to perform the plan above.`);
    console.log(`  financial fingerprint UNCHANGED : ${before.hash}`);
    await db.$disconnect();
    return;
  }

  await db.$transaction(async (tx) => {
    if (artifactIds.size > 0) {
      const del = await tx.transactionObservation.deleteMany({ where: { id: { in: [...artifactIds] } } });
      console.log(`  deleted ${del.count} observation(s)`);
    }
    // ⚠️ Re-derivation goes through the CANONICAL authority (`reprojectEvent`),
    // never a projection this script expresses itself. A repair that computed
    // its own projection would be a second answer to "what state is this event
    // in" — the exact duplication the L8 writer probe exists to prevent.
    for (const id of touchedEventIds) {
      await reprojectEvent(tx, id);
      const ev = await tx.transactionEvent.findUnique({
        where: { id }, select: { lifecycle: true, observationCount: true, currentTransactionId: true },
      });
      console.log(`  reprojected ${id} → ${ev?.lifecycle} · obs=${ev?.observationCount} · currentTx=${ev?.currentTransactionId ?? "null"}`);
    }
  });

  const after = await financialFingerprint();
  bar("6. FINANCIAL FINGERPRINT");
  console.log(`  before : ${before.hash}  (${before.rows} rows)`);
  console.log(`  after  : ${after.hash}  (${after.rows} rows)`);
  if (before.hash !== after.hash || before.rows !== after.rows) {
    console.log(`  ✗ A TRANSACTION-LEVEL FACT MOVED. This repair must not do that.`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ unchanged — no financial fact was touched.`);
  }

  await db.$disconnect();
}

main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
