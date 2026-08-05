/**
 * scripts/audit-event-identity.ts   (L8 — Parts 7, 8, 9, 10)
 *
 * The standing corpus probe for event identity. READ-ONLY.
 *
 *  - structural invariants that need the whole corpus
 *  - first-observed coverage (Part 7)
 *  - provider-latency READINESS, with pre-backfill values labelled unknown (Part 8)
 *
 * Run: npx tsx --env-file=.env.local scripts/audit-event-identity.ts
 *      (or: npm run audit:event-identity)
 */

import { db } from "@/lib/db";
import { createHash } from "node:crypto";
import { projectEvent, type ObservationFacts } from "@/lib/transactions/event-identity";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const pct = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`);
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

async function main() {
  console.log(`\n[AUDIT] Event identity — READ-ONLY\n`);

  const events = await db.transactionEvent.findMany({
    select: {
      id: true, financialAccountId: true, lifecycle: true, economicDate: true,
      currentAmount: true, currentTransactionId: true, observationCount: true,
      firstObservedAt: true, lastObservedAt: true, firstPendingObservedAt: true, postedObservedAt: true,
    },
  });
  const observations = await db.transactionObservation.findMany({
    select: {
      id: true, eventId: true, transactionId: true, financialAccountId: true, provider: true,
      providerRowId: true, providerPendingRef: true, observedAt: true, lifecycle: true,
      amount: true, postingDate: true, economicDate: true, observationKey: true,
    },
  });
  const txs = await db.transaction.findMany({
    select: { id: true, transactionEventId: true, deletedAt: true, economicDate: true, date: true, pending: true, createdAt: true },
  });
  const T = new Map(txs.map((t) => [t.id, t]));

  bar("POPULATION");
  console.log(`  logical events        : ${events.length}`);
  console.log(`  observations          : ${observations.length}`);
  console.log(`  transactions linked   : ${txs.filter((t) => t.transactionEventId).length} / ${txs.length}`);
  const byLc = new Map<string, number>();
  for (const e of events) byLc.set(e.lifecycle, (byLc.get(e.lifecycle) ?? 0) + 1);
  console.log(`  lifecycle             :`, Object.fromEntries(byLc));
  console.log(`  multi-observation     : ${events.filter((e) => e.observationCount > 1).length}`);

  bar("STRUCTURAL INVARIANTS");
  // 1 — one observation belongs to exactly one event.
  const eventIds = new Set(events.map((e) => e.id));
  check("INV-1 every observation belongs to exactly one existing event",
    observations.every((o) => eventIds.has(o.eventId)));
  // 2 — one transaction row links to at most one event (the FK guarantees it);
  //     and every observation's row links to ITS event, not another's.
  const mismatched = observations.filter(
    (o) => o.transactionId && T.get(o.transactionId)?.transactionEventId !== o.eventId);
  check("INV-2 every observed row links to the event that observed it", mismatched.length === 0,
    mismatched.slice(0, 3).map((o) => `${o.transactionId} → ${T.get(o.transactionId!)?.transactionEventId} ≠ ${o.eventId}`).join("; "));
  // 5 — observation keys are unique (the DB enforces it; verified in case a
  //     future writer bypasses the constraint via raw SQL).
  check("INV-5 observation keys are unique",
    new Set(observations.map((o) => o.observationKey)).size === observations.length);
  // 4 — at most one LIVE row per event: pending and posted cannot both count.
  const liveByEvent = new Map<string, number>();
  for (const o of observations) {
    const t = o.transactionId ? T.get(o.transactionId) : undefined;
    if (t && !t.deletedAt) liveByEvent.set(o.eventId, (liveByEvent.get(o.eventId) ?? 0) + 1);
  }
  const doubleCount = [...liveByEvent.entries()].filter(([, n]) => n > 1);
  check("INV-4 no event has two LIVE transaction rows", doubleCount.length === 0,
    doubleCount.slice(0, 3).map(([e, n]) => `${e}: ${n}`).join("; "));

  // Re-derive every projection and compare — the event state must be a pure
  // function of its observations, or it has drifted.
  const obsByEvent = new Map<string, typeof observations>();
  for (const o of observations) (obsByEvent.get(o.eventId) ?? obsByEvent.set(o.eventId, []).get(o.eventId)!).push(o);
  let drift = 0;
  const driftExamples: string[] = [];
  for (const e of events) {
    const os = obsByEvent.get(e.id) ?? [];
    if (os.length === 0) { drift++; driftExamples.push(`${e.id}: no observations`); continue; }
    const facts: ObservationFacts[] = os.map((o) => {
      const t = o.transactionId ? T.get(o.transactionId) : undefined;
      return {
        observedAt: o.observedAt, lifecycle: o.lifecycle as "PENDING" | "POSTED",
        amount: o.amount, postingDate: o.postingDate, economicDate: o.economicDate,
        liveTransactionId: t && !t.deletedAt ? t.id : null,
      };
    });
    const p = projectEvent(facts);
    const same =
      p.lifecycle === e.lifecycle &&
      p.economicDate.toISOString() === e.economicDate.toISOString() &&
      Math.abs(p.currentAmount - e.currentAmount) < 0.005 &&
      (p.currentTransactionId ?? null) === (e.currentTransactionId ?? null) &&
      p.observationCount === e.observationCount;
    if (!same) { drift++; if (driftExamples.length < 4) driftExamples.push(`${e.id}: stored ${e.lifecycle}/${e.currentAmount} vs derived ${p.lifecycle}/${p.currentAmount}`); }
  }
  check("the stored projection equals the derived projection for every event", drift === 0, driftExamples.join("; "));

  // 7 — economic date does not move on posting.
  let moved = 0;
  for (const [, os] of obsByEvent) {
    if (os.length < 2) continue;
    const uniq = new Set(os.map((o) => o.economicDate.toISOString()));
    if (uniq.size > 1) moved++;
  }
  check("INV-7 no multi-observation event has a moving economic date", moved === 0, `${moved} moved`);
  // ...and the event's economic date matches its live row's.
  const econMismatch = events.filter((e) => {
    if (!e.currentTransactionId) return false;
    const t = T.get(e.currentTransactionId);
    return t?.economicDate && t.economicDate.toISOString() !== e.economicDate.toISOString();
  });
  check("the event's economic date matches its live row's", econMismatch.length === 0,
    econMismatch.slice(0, 3).map((e) => e.id).join("; "));

  // 17 — crypto stayed out.
  const cryptoObs = observations.filter((o) => o.provider === "WALLET" || o.provider === "EXCHANGE");
  check("INV-17 no crypto observation entered the banking tables", cryptoObs.length === 0);

  bar("PART 7 — FIRST-OBSERVED COVERAGE");
  const withPending = events.filter((e) => e.firstPendingObservedAt != null);
  const withPosted = events.filter((e) => e.postedObservedAt != null);
  console.log(`  events with firstObservedAt        : ${events.length}  (100%)`);
  console.log(`  events with firstPendingObservedAt : ${withPending.length}  ${pct(withPending.length, events.length)}`);
  console.log(`  events with postedObservedAt       : ${withPosted.length}  ${pct(withPosted.length, events.length)}`);

  // The population the FUTURE precedence would affect: no authorizedAt, but a
  // first-pending observation now exists.
  const noAuth = await db.transaction.findMany({
    where: { authorizedAt: null, transactionEventId: { not: null } },
    select: { id: true, transactionEventId: true, date: true, economicDate: true },
  });
  const eventById = new Map(events.map((e) => [e.id, e]));
  const gained = noAuth.filter((t) => {
    const e = t.transactionEventId ? eventById.get(t.transactionEventId) : undefined;
    return e?.firstPendingObservedAt != null;
  });
  console.log(`\n  rows lacking authorizedAt              : ${noAuth.length}`);
  console.log(`  ...that NOW have first-pending evidence: ${gained.length}`);
  console.log(`\n  ⚠️ PROPOSED future precedence (NOT applied in this slice):`);
  console.log(`       first credible pending observation ?? authorizedAt ?? posting date`);
  console.log(`     Changing economicDate again is a separate MEASURED cutover, exactly as`);
  console.log(`     the current one was. On this corpus it would affect ${gained.length} row(s).`);

  bar("PART 8 — PROVIDER LATENCY READINESS");
  // ⚠️ Every backfilled observedAt is Transaction.createdAt — a RECONSTRUCTION,
  // not a measurement. Latency derived from it would describe when we wrote the
  // row, not when the provider delivered it.
  const backfillCutoff = observations.reduce((min, o) => (o.observedAt < min ? o.observedAt : min), new Date());
  const prospective = observations.filter((o) => o.observedAt.getTime() > Date.now() - 60_000);
  console.log(`  observations recorded                 : ${observations.length}`);
  console.log(`  ...from the BACKFILL (reconstructed)  : ${observations.length - prospective.length}`);
  console.log(`  ...observed live since dual-write     : ${prospective.length}`);
  console.log(`  earliest observedAt in the table      : ${backfillCutoff.toISOString().slice(0, 10)}`);
  console.log(`\n  ⚠️ EVERY value above is UNKNOWN for latency purposes. Backfilled observedAt`);
  console.log(`     is Transaction.createdAt — when Fourth Meridian wrote the row, not when`);
  console.log(`     the provider delivered it. Latency is PROSPECTIVE from here.`);
  console.log(`\n  measurable once live observations accumulate:`);
  for (const m of [
    "pending first seen → posted first seen   (firstPendingObservedAt → postedObservedAt)",
    "authorized date    → pending first seen   (observation.authorizedAt → observedAt)",
    "posted date        → posted first seen    (observation.postingDate → observedAt)",
    "per-institution distributions             (join through financialAccount.institutionId)",
  ]) console.log(`    · ${m}`);
  // The one thing measurable TODAY, and honestly labelled.
  const chains = [...obsByEvent.values()].filter((os) => os.length > 1);
  const postingLag = new Map<number, number>();
  for (const os of chains) {
    const pre = os.find((o) => o.lifecycle === "PENDING"), post = os.find((o) => o.lifecycle === "POSTED");
    if (!pre || !post) continue;
    const d = Math.round((post.postingDate.getTime() - pre.postingDate.getTime()) / 86_400_000);
    postingLag.set(d, (postingLag.get(d) ?? 0) + 1);
  }
  console.log(`\n  POSTING-DATE lag across ${chains.length} chains (a provider-DATED fact, so measurable now):`);
  console.log(`    ${[...postingLag].sort((a, b) => a[0] - b[0]).map(([d, c]) => `${d}d:${c}`).join("  ")}`);

  bar("FINGERPRINTS");
  const fp = (label: string, parts: string[]) =>
    console.log(`  ${label.padEnd(28)} ${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16)}  (${parts.length})`);
  fp("events", events.map((e) => `${e.id}|${e.lifecycle}|${e.economicDate.toISOString()}|${e.currentAmount}|${e.currentTransactionId}|${e.observationCount}`).sort());
  fp("observations", observations.map((o) => `${o.observationKey}|${o.eventId}|${o.transactionId}|${o.lifecycle}|${o.amount}`).sort());
  fp("transaction → event links", txs.filter((t) => t.transactionEventId).map((t) => `${t.id}|${t.transactionEventId}`).sort());

  if (failures > 0) {
    console.error(`\n[AUDIT] FAILED — ${failures} invariant(s) violated.\n`);
    await db.$disconnect();
    process.exit(1);
  }
  console.log(`\n[AUDIT] PASSED — event identity holds across the corpus. ✓\n`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
