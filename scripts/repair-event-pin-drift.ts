/**
 * scripts/repair-event-pin-drift.ts   (EVENT-WRITE-1 residue)
 *
 * DRY-RUN BY DEFAULT. `--apply` is required to write anything.
 *
 * Re-pins a live transaction row whose `economicDate` has drifted off its own
 * event's published pin. It repairs ONLY that residue. The write-path fixes are
 * what stop it recurring, and they landed first, deliberately:
 *   · 9724d76 EVENT-WRITE-1 — the claim ordering and the liveness FK gate
 *   · 156f871 RLS-P-2b     — the failure stops being console-only
 *
 * ── WHY NOT repair-event-identity-adoption-artifacts.ts ─────────────────────
 * That script exists for the v2.6-EVENT-2 residue: duplicate observations left
 * under a re-keyed provider id. It was run first and it ABORTED, correctly — its
 * shape guards found 2936 stale events against a measured blast radius of 4,
 * because it wants to re-pin every event whose observation set it considers
 * stale. This residue is a different shape: one observation, agreeing with its
 * event, and a row that drifted away from both. Forcing that script would have
 * rewritten two thousand events to fix two rows.
 *
 * ── WHAT IS CANONICAL HERE, AND WHAT IS NOT ─────────────────────────────────
 * Measured before-state of the two rows:
 *
 *   EVENT cmu2z2a5q…  pin 2026-09-10     OBS 2026-09-10     ROW 2026-09-09
 *   EVENT cmupscz6y…  pin 2026-09-25     OBS 2026-09-25     ROW 2026-09-24
 *
 * The event and its observation agree. Only the row is wrong, because the
 * fingerprint adoption wrote `...econFields` over a row an event already pinned
 * and the observation that would have re-pinned it aborted on P2002.
 *
 * ⚠️ `authorizedAt` IS NOT REPAIRED, AND MUST NOT BE. The row's authorizedAt is
 * 2026-09-09 because the second settlement genuinely carried that
 * `authorized_date`. It is a PROVIDER FACT. Rewriting it to make the row's own
 * evidence re-derive the pin would fabricate history to satisfy an audit — and
 * the whole point of B-6 is that a provider restating its date does not move a
 * published economic date. A row whose economicDate is its event's pin while its
 * authorizedAt records what the provider last said is the CORRECT terminal state,
 * not a compromise.
 *
 * So this writes exactly one column, and only where it disagrees — the same
 * statement the writer's own `pinRowToEvent` (lib/transactions/event-write.ts:770)
 * issues, scoped to the drifted rows.
 *
 * Run:
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs --env-file=.env.local \
 *     scripts/repair-event-pin-drift.ts [--apply]
 */

import "server-only";
import { db } from "@/lib/db";

const APPLY = process.argv.includes("--apply");

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  console.log(`\n${APPLY ? "[APPLY] event-pin drift repair — WRITING" : "[DRY RUN] event-pin drift repair — READ-ONLY, no writes"}`);
  console.log("Selection: a LIVE transaction that is its event's current row and whose");
  console.log("           economicDate differs from that event's pin.\n");

  // The population, derived — never a hard-coded id list. If the writer fix is
  // sound this returns zero rows for ever after; if it returns something new,
  // that is a live defect and the count is the alarm.
  const events = await db.transactionEvent.findMany({
    where: { currentTransactionId: { not: null } },
    select: { id: true, economicDate: true, currentTransactionId: true },
  });

  const rows = await db.transaction.findMany({
    where: { id: { in: events.map((e) => e.currentTransactionId!) }, deletedAt: null },
    select: { id: true, economicDate: true, authorizedAt: true, date: true, transactionEventId: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const drifted = events.flatMap((e) => {
    const r = byId.get(e.currentTransactionId!);
    if (!r || !r.economicDate) return [];
    if (iso(r.economicDate) === iso(e.economicDate)) return [];
    // ⚠️ The row must still BELONG to this event. Without this a row that moved
    // on would be re-pinned to an event that no longer owns it — the mirror of
    // the liveness bug EVENT-WRITE-1 fixed in reprojectEvent.
    if (r.transactionEventId !== e.id) return [];
    return [{ eventId: e.id, rowId: r.id, from: iso(r.economicDate), to: iso(e.economicDate),
              authorizedAt: r.authorizedAt ? iso(r.authorizedAt) : null, posting: iso(r.date) }];
  });

  if (drifted.length === 0) {
    console.log("No drifted rows. Nothing to repair.\n");
    await db.$disconnect();
    return;
  }

  console.log("ROW                         econ FROM → TO          authorizedAt (UNTOUCHED)  posting");
  console.log("-".repeat(100));
  for (const d of drifted) {
    console.log(`${d.rowId}  ${d.from} → ${d.to}      ${d.authorizedAt ?? "—"}                ${d.posting}`);
  }
  console.log("-".repeat(100));
  console.log(`Total: ${drifted.length} row(s)\n`);

  if (!APPLY) {
    console.log("Dry run only — no writes. Back up the database, then re-run with --apply.\n");
    await db.$disconnect();
    return;
  }

  let repaired = 0;
  for (const d of drifted) {
    // The writer's own statement (pinRowToEvent): guarded by NOT-equal so a
    // concurrent correct write makes this a no-op rather than a second write.
    const res = await db.transaction.updateMany({
      where: { id: d.rowId, transactionEventId: d.eventId, NOT: { economicDate: new Date(`${d.to}T00:00:00.000Z`) } },
      data:  { economicDate: new Date(`${d.to}T00:00:00.000Z`) },
    });
    repaired += res.count;
    console.log(`  REPIN row=${d.rowId} event=${d.eventId}  BEFORE economicDate=${d.from}  →  AFTER ${d.to}  (authorizedAt left at ${d.authorizedAt ?? "—"})`);
  }
  console.log(`\nApplied — re-pinned ${repaired} row(s). Re-run (dry) to verify 0 remain.\n`);
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
