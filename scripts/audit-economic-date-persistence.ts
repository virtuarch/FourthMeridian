/**
 * scripts/audit-economic-date-persistence.ts   (L8-A)
 *
 * The STANDING PROBE for the persisted economic chronology. READ-ONLY.
 *
 * ── THE INVARIANT, AND THE ONE IT REPLACED (2026-10-02) ─────────────────────
 * This audit shipped asserting:
 *
 *     for every row:  Transaction.economicDate === resolveEconomicDate(row)
 *
 * That was true until B-6 (c1036dd, 2026-08-17), which made the EVENT the
 * authority for an event-linked row. From then on the writer resolved with one
 * more piece of evidence than this audit had:
 *
 *     lib/transactions/event-identity.ts:273
 *         firstPendingDate: firstPending?.economicDate ?? null
 *
 * and `resolveEconomicDate` ranks a credible first-pending date FIRST — "first
 * resolution wins". The audit selected five columns and `transactionEventId`
 * was not among them, so it recomputed from row evidence alone and was
 * STRUCTURALLY BLIND to the pin. When a provider restates `authorized_date`
 * between the pending and the posted delivery — which Plaid does — the audit
 * reported DRIFT on four rows whose stored value was exactly right.
 *
 * Worse, it printed a remediation that could not touch them: the backfill it
 * named skips event-linked rows by design (backfill-economic-date.ts:55), so
 * `--apply` planned ZERO rows against a failure of four. Measured: 98 event-free
 * rows, 0 disagreeing; 4835 event-linked, 4 disagreeing.
 *
 * ── SO THE POPULATION IS SPLIT, AND NEITHER HALF IS EXEMPTED ────────────────
 *
 *   EVENT-FREE rows  (no transactionEventId)
 *       Transaction.economicDate === resolveEconomicDate(row evidence)
 *       — unchanged. This is the original invariant, on the population it is
 *         still the whole truth for.
 *
 *   EVENT-LINKED rows
 *       (a) Transaction.economicDate === TransactionEvent.economicDate
 *           The row carries the event's pin, which is what reprojectEvent
 *           materialises (event-write.ts:462-465). This is the check that
 *           catches the Talabat adoption defect: a fingerprint adoption that
 *           overwrites the row's date and leaves the event's pin behind.
 *       (b) TransactionEvent.economicDate === resolveEconomicDate(
 *               row evidence ∪ the FIRST PENDING observation's economic date)
 *           The pin itself must be the authority's answer, not merely stable.
 *           Without (b) an event could hold any value forever and (a) would
 *           happily agree with it.
 *
 * (a) without (b) is a tautology waiting to happen; (b) without (a) would miss
 * the defect that prompted this rewrite. Both, or neither is worth running.
 *
 * A persisted derived value can still drift in the three original ways — a
 * writer that forgets it, a backfill that never finished, a credibility bound
 * that is not replayed — and now also by an adoption that moves a row off its
 * event. This catches all four.
 *
 * Run:  npx tsx --env-file=.env.local scripts/audit-economic-date-persistence.ts
 *       (or: npm run audit:economic-date)
 *
 * Exit 0 when the whole table agrees; 1 otherwise, with a non-PII breakdown.
 * Safe for CI — no writes.
 */

import { db } from "@/lib/db";
import { createHash } from "node:crypto";
import { resolveEconomicDate } from "@/lib/transactions/economic-date";
import { ECONOMIC_DATE_MAX_LAG_DAYS } from "@/lib/transactions/economic-date";

const iso = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  console.log(`\n[AUDIT] Economic-date persistence — stored vs derived, READ-ONLY\n`);

  // ⚠️ `transactionEventId` IS LOAD-BEARING, NOT DECORATIVE. Its absence here is
  // the entire defect this rewrite closes, and scripts/audit-event-identity.ts's
  // own guard now asserts this file references it.
  const rows = await db.transaction.findMany({
    select: {
      id: true, date: true, authorizedAt: true, economicDate: true, deletedAt: true,
      transactionEventId: true,
      transactionEvent: { select: { id: true, economicDate: true } },
    },
  });

  // The FIRST PENDING observation per event — the "first resolution" the pin
  // must equal. Ordered by observedAt, so the earliest PENDING payload wins,
  // which is what projectEvent feeds to resolveEconomicDate as firstPendingDate.
  const pendingObs = await db.transactionObservation.findMany({
    where:   { lifecycle: "PENDING" },
    select:  { eventId: true, economicDate: true, observedAt: true },
    orderBy: { observedAt: "asc" },
  });
  const firstPendingByEvent = new Map<string, Date>();
  for (const o of pendingObs) {
    if (!firstPendingByEvent.has(o.eventId)) firstPendingByEvent.set(o.eventId, o.economicDate);
  }

  let agree = 0;
  const missing: string[] = [];
  const disagree: { id: string; stored: string; derived: string; basis: string }[] = [];
  const basis = new Map<string, number>();
  let movers = 0, monthCrossers = 0, contradictory = 0;

  let eventFree = 0, eventLinked = 0;
  const unpinned: { id: string; row: string; pin: string }[] = [];

  for (const r of rows) {
    // The evidence the WRITER had. For an event-linked row that includes the
    // first-pending date; omitting it is what made this audit blind.
    const firstPendingDate = r.transactionEventId
      ? firstPendingByEvent.get(r.transactionEventId) ?? null
      : null;
    const res = resolveEconomicDate({
      postingDate: r.date, authorizedAt: r.authorizedAt, firstPendingDate,
    });
    basis.set(res.basis, (basis.get(res.basis) ?? 0) + 1);
    if (res.state === "CONTRADICTORY") contradictory++;
    if (res.economicDate !== res.postingDate) movers++;
    if (res.economicDate.slice(0, 7) !== res.postingDate.slice(0, 7)) monthCrossers++;

    if (r.economicDate == null) { missing.push(r.id); continue; }

    // ── EVENT-FREE: the original invariant, on the population it still owns ──
    if (!r.transactionEvent) {
      eventFree++;
      if (iso(r.economicDate) === res.economicDate) { agree++; continue; }
      disagree.push({ id: r.id, stored: iso(r.economicDate), derived: res.economicDate, basis: res.basis });
      continue;
    }

    // ── EVENT-LINKED: (a) the row carries the pin, (b) the pin is derivable ──
    eventLinked++;
    const pin = iso(r.transactionEvent.economicDate);
    let ok = true;
    if (iso(r.economicDate) !== pin) {
      // (a) The row has moved off its event. This is the Talabat adoption shape.
      unpinned.push({ id: r.id, row: iso(r.economicDate), pin });
      ok = false;
    }
    // ── (b) WAS HERE, AND IT WAS MINE, AND IT WAS WRONG. ────────────────────
    //
    // I added a second check — "the event's pin must be what resolveEconomicDate
    // answers" — on the correct instinct that (a) alone is a tautology waiting to
    // happen: an event could hold any value for ever and the row would dutifully
    // agree with it. The instinct was right and the implementation was not,
    // because it fed the resolver THE ROW'S COLUMNS.
    //
    // An event's pin is not derived from its current row. It is derived from its
    // OBSERVATIONS — that is what projectEvent reads. The two part company
    // exactly where this audit has to be careful: the repaired Talabat rows carry
    // pin 2026-09-10 (settlement A's authorized_date, recorded in the event's
    // observation) while the row's own authorizedAt is 2026-09-09, settlement B's
    // genuine provider fact, deliberately preserved because rewriting it to make
    // a row re-derive its own pin would fabricate history to satisfy an audit.
    // So the pin is NOT derivable from the row, and never should have been
    // expected to be. My check called correct data corrupt, in the opposite
    // direction from the original defect.
    //
    // The invariant itself is real and is ALREADY OWNED, with the right evidence:
    //   scripts/audit-event-identity.ts:112 — "the stored projection equals the
    //   derived projection for every event", which compares
    //   projectEvent(observations).economicDate against the stored pin, over all
    //   4727 events, and passes.
    //
    // So this is not a deleted invariant; it is a duplicate implemented from the
    // wrong input, removed in favour of the correct one. (a) is not left a
    // tautology: the event-identity audit is what stops an event holding an
    // arbitrary pin, and INV-7 there separately pins first-resolution-wins.
    if (ok) agree++;
  }

  console.log(`  rows (tombstones included)      : ${rows.length}`);
  console.log(`    event-FREE   (row evidence)   : ${eventFree}`);
  console.log(`    event-LINKED (event pin, B-6) : ${eventLinked}`);
  console.log(`  agrees with its authority       : ${agree}`);
  console.log(`  NULL (never backfilled)         : ${missing.length}`);
  console.log(`  stored !== derived (DRIFT)      : ${disagree.length}`);
  console.log(`\n  credibility bound in force      : ${ECONOMIC_DATE_MAX_LAG_DAYS} days`);
  console.log(`  resolution basis:`);
  for (const [k, v] of [...basis].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(5)}  ${k}`);
  console.log(`  economic ≠ posting              : ${movers}`);
  console.log(`  ...crossing a MONTH boundary    : ${monthCrossers}`);
  console.log(`  CONTRADICTORY (falls back)      : ${contradictory}`);

  const fp = createHash("sha256")
    .update(rows.map((r) => `${r.id}|${r.economicDate ? iso(r.economicDate) : "null"}`).sort().join("\n"))
    .digest("hex").slice(0, 16);
  console.log(`\n  persisted economicDate fingerprint: ${fp} (${rows.length} rows)`);

  // The chronologies must remain SEPARATE facts. A column that silently equalled
  // `date` everywhere would pass the agreement check and mean nothing.
  if (movers === 0 && rows.length > 0) {
    console.error(`\n[AUDIT] SUSPICIOUS — not one row's economic date differs from its posting date.`);
    console.error(`That is possible but unlikely; verify authorizedAt is actually being captured.\n`);
  }

  console.log(`  event-linked rows OFF their pin : ${unpinned.length}`);

  // ⚠️ THE DOCTRINE MUST BE OBSERVABLY IN FORCE, NOT MERELY CODED FOR.
  //
  // Once check (b) was removed as wrong-headed (see above), `firstPendingDate`
  // stopped affecting any comparison: it feeds only the basis tally. I measured
  // that — stripping it from the resolver left this audit GREEN at 4933/4933,
  // which means the guard in lib/transactions/event-economic-date-rule.test.ts
  // asserting that this file "feeds the first-pending evidence the writer uses"
  // was pinning a line with no consequence. A source scan over a value nothing
  // reads is decoration, and decoration is what let the original invariant rot
  // for seven weeks.
  //
  // So the tally becomes an assertion. If any event is pinned by a first-pending
  // observation, this audit must RESOLVE some row that way — a corpus-aware
  // non-vacuity check, and the thing that goes red the moment the evidence is
  // dropped from the resolver again.
  const firstPendingResolved = basis.get("FIRST_PENDING_OBSERVATION") ?? 0;
  const pinnedEvents = firstPendingByEvent.size;
  console.log(`  events with a first PENDING obs  : ${pinnedEvents}`);
  console.log(`  rows resolved by that pin        : ${firstPendingResolved}`);
  const doctrineObserved = pinnedEvents === 0 || firstPendingResolved > 0;
  if (!doctrineObserved) {
    console.error(`\n[AUDIT] FAILED — ${pinnedEvents} event(s) are pinned by a first PENDING observation,`);
    console.error(`but not one row resolved on that basis. The first-pending evidence is not reaching`);
    console.error(`resolveEconomicDate, so this audit is adjudicating B-6 rows without B-6's evidence —`);
    console.error(`the exact blindness that reported four correct rows as DRIFT until 2026-10-02.\n`);
    await db.$disconnect();
    process.exit(1);
  }

  if (missing.length === 0 && disagree.length === 0 && unpinned.length === 0) {
    console.log(`\n[AUDIT] PASSED — every row's persisted economicDate equals the authority's value. ✓\n`);
    await db.$disconnect();
    return;
  }

  console.error(`\n[AUDIT] FAILED — the persisted chronology does not match its authority.`);

  // ⚠️ EACH POPULATION NAMES THE REPAIR THAT CAN ACTUALLY REACH IT. The previous
  // version printed ONE command for every failure, and that command skips
  // event-linked rows — so a four-row failure was answered with a zero-row plan.
  // An audit that recommends a no-op is worse than one that recommends nothing.
  if (disagree.length) {
    console.error(`\n  EVENT-FREE rows whose stored date ≠ row-evidence derivation (${disagree.length}):`);
    for (const d of disagree.slice(0, 20)) {
      console.error(`    ${d.id} stored=${d.stored} derived=${d.derived} (${d.basis})`);
    }
    console.error(`  → npx tsx --env-file=.env.local scripts/backfill-economic-date.ts --apply`);
    console.error(`    (this backfill handles EXACTLY this population — it skips event-linked rows by design)`);
  }
  if (unpinned.length) {
    console.error(`\n  EVENT-LINKED rows that have moved OFF their event's pin (${unpinned.length}):`);
    for (const d of unpinned.slice(0, 20)) console.error(`    ${d.id} row=${d.row} eventPin=${d.pin}`);
    console.error(`  → the row must be re-pinned to its event, NOT re-derived from its own columns.`);
    console.error(`    scripts/repair-event-projection-drift.ts  (see backfill-economic-date.ts:22-26)`);
    console.error(`    ⚠️ If any of these was written RECENTLY, this is a live WRITER defect and the`);
    console.error(`       repair is second: a fingerprint adoption can overwrite a row's economicDate`);
    console.error(`       and leave the event's pin behind. Fix the writer, then repair the artifacts.`);
  }
  if (missing.length) {
    console.error(`\n  ${missing.length} row(s) have NO persisted economicDate.`);
    console.error(`  → npx tsx --env-file=.env.local scripts/backfill-economic-date.ts --apply`);
  }
  console.error("");
  await db.$disconnect();
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
