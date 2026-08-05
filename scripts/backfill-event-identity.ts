/**
 * scripts/backfill-event-identity.ts   (L8 — Part 5)
 *
 * Reconstruct observations and logical events from the EVIDENCE ALREADY IN THE
 * CORPUS. DRY-RUN BY DEFAULT; `--apply` is required to write.
 *
 * ── What it uses, and what it refuses ──────────────────────────────────────
 *
 * Provider evidence only: `pendingTransactionRef` → `plaidTransactionId`, and
 * the row's own provider id. NO fuzzy identity — nothing is joined on amount,
 * merchant, proximity or cadence, and there is no code path here that could.
 *
 * ⚠️ It STOPS if any transaction row would be linked ambiguously.
 *
 * ── Observation times are RECONSTRUCTED, and labelled as such ───────────────
 *
 * The corpus predates the observation system, so a true `observedAt` does not
 * exist for historical rows. `createdAt` is the closest honest proxy — it is
 * when Fourth Meridian first wrote the row — and Part 8's latency measurement
 * must therefore treat every backfilled value as UNKNOWN and measure
 * prospectively. That is stated here so the next reader cannot mistake a
 * reconstruction for a measurement.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/backfill-event-identity.ts
 *   npx tsx --env-file=.env.local scripts/backfill-event-identity.ts --apply
 */

import { db } from "@/lib/db";
import { createHash } from "node:crypto";
import type { ProviderType } from "@prisma/client";
import { projectEvent, type ObservationFacts } from "@/lib/transactions/event-identity";
import { observationKey, isEventEligibleProvider } from "@/lib/transactions/event-identity";

const BATCH = 200;
const iso = (d: Date) => d.toISOString().slice(0, 10);

type Row = {
  id: string; financialAccountId: string | null; date: Date; economicDate: Date | null;
  authorizedAt: Date | null; amount: number; pending: boolean; settlementState: string | null;
  deletedAt: Date | null; plaidTransactionId: string | null; pendingTransactionRef: string | null;
  externalTransactionId: string | null; importBatchId: string | null; createdAt: Date; merchant: string;
};

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`\n[backfill-event-identity] ${apply ? "APPLY" : "DRY RUN"}\n`);

  const accounts = await db.financialAccount.findMany({
    select: { id: true, plaidAccountId: true, walletAddress: true, institution: true },
  });
  const A = new Map(accounts.map((a) => [a.id, a]));
  const rows: Row[] = await db.transaction.findMany({
    select: {
      id: true, financialAccountId: true, date: true, economicDate: true, authorizedAt: true,
      amount: true, pending: true, settlementState: true, deletedAt: true,
      plaidTransactionId: true, pendingTransactionRef: true, externalTransactionId: true,
      importBatchId: true, createdAt: true, merchant: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const providerOf = (r: Row): ProviderType => {
    const a = r.financialAccountId ? A.get(r.financialAccountId) : undefined;
    if (a?.walletAddress) return "WALLET";
    if (r.importBatchId || r.externalTransactionId) return "CSV";
    if (r.plaidTransactionId || a?.plaidAccountId) return "PLAID";
    return "MANUAL";
  };

  // ── Scope ────────────────────────────────────────────────────────────────
  const considered = rows.length;
  const noAccount = rows.filter((r) => !r.financialAccountId);
  const crypto = rows.filter((r) => providerOf(r) === "WALLET");
  const noEconomic = rows.filter((r) => r.financialAccountId && r.economicDate == null);
  const eligible = rows.filter(
    (r) => r.financialAccountId && r.economicDate != null && isEventEligibleProvider(providerOf(r)));

  console.log(`  transaction rows considered      : ${considered}`);
  console.log(`  refused — no financialAccountId  : ${noAccount.length}`);
  console.log(`  refused — crypto/wallet (by scope): ${crypto.length}`);
  console.log(`  refused — no economicDate        : ${noEconomic.length}`);
  console.log(`  ELIGIBLE (banking)               : ${eligible.length}`);

  // ── Chain resolution — provider evidence ONLY ────────────────────────────
  const byPlaidId = new Map<string, Row>();
  for (const r of rows) if (r.plaidTransactionId) byPlaidId.set(r.plaidTransactionId, r);

  const claims = new Map<string, string[]>();   // pendingRef → posted row ids
  for (const r of eligible) {
    if (!r.pendingTransactionRef) continue;
    (claims.get(r.pendingTransactionRef) ?? claims.set(r.pendingTransactionRef, []).get(r.pendingTransactionRef)!).push(r.id);
  }

  /** successorId → predecessor row, only where the evidence is unambiguous. */
  const predecessorOf = new Map<string, Row>();
  const refusals = new Map<string, string[]>();
  const refuse = (why: string, id: string) =>
    (refusals.get(why) ?? refusals.set(why, []).get(why)!).push(id);

  for (const r of eligible) {
    const ref = r.pendingTransactionRef;
    if (!ref) continue;
    if ((claims.get(ref)?.length ?? 0) > 1) { refuse("AMBIGUOUS_PREDECESSOR", r.id); continue; }
    const pre = byPlaidId.get(ref);
    if (!pre) { refuse("DANGLING_PENDING_REF", r.id); continue; }
    if (pre.financialAccountId !== r.financialAccountId) { refuse("CROSS_ACCOUNT_REF", r.id); continue; }
    if (!isEventEligibleProvider(providerOf(pre))) { refuse("PREDECESSOR_OUT_OF_SCOPE", r.id); continue; }
    predecessorOf.set(r.id, pre);
  }

  // ⚠️ A predecessor must be claimed by AT MOST ONE successor, or 1:1 identity
  // does not hold. Checked from the other direction as well as via `claims`.
  const successorsOf = new Map<string, string[]>();
  for (const [succ, pre] of predecessorOf) {
    (successorsOf.get(pre.id) ?? successorsOf.set(pre.id, []).get(pre.id)!).push(succ);
  }
  const fanIn = [...successorsOf.entries()].filter(([, v]) => v.length > 1);
  if (fanIn.length > 0) {
    console.error(`\n  ✗ STOP — ${fanIn.length} predecessor(s) claimed by more than one successor.`);
    for (const [pre, succs] of fanIn.slice(0, 10)) console.error(`     ${pre} ← ${succs.join(", ")}`);
    process.exit(1);
  }

  // ── Group rows into events ───────────────────────────────────────────────
  const eventOfRow = new Map<string, string>();   // row id → synthetic event key
  for (const r of eligible) {
    const pre = predecessorOf.get(r.id);
    // The predecessor's id IS the event key — stable, deterministic, and derived
    // from provider evidence alone.
    eventOfRow.set(r.id, pre ? pre.id : (eventOfRow.get(r.id) ?? r.id));
  }
  // A predecessor belongs to its own event.
  for (const [, pre] of predecessorOf) eventOfRow.set(pre.id, pre.id);

  const groups = new Map<string, Row[]>();
  for (const r of eligible) {
    const k = eventOfRow.get(r.id)!;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }

  const multi = [...groups.values()].filter((g) => g.length > 1);
  const single = [...groups.values()].filter((g) => g.length === 1);

  // Lifecycle census of the proposed events.
  let withdrawn = 0, pendingEvents = 0, postedEvents = 0;
  const proposals: { key: string; rows: Row[]; projection: ReturnType<typeof projectEvent> }[] = [];
  for (const [key, g] of groups) {
    const facts: ObservationFacts[] = g.map((r) => ({
      observedAt: r.createdAt,
      lifecycle: (r.pending ? "PENDING" : "POSTED") as "PENDING" | "POSTED",
      amount: r.amount,
      postingDate: r.date,
      economicDate: r.economicDate as Date,
      liveTransactionId: r.deletedAt ? null : r.id,
    }));
    const p = projectEvent(facts);
    if (p.lifecycle === "WITHDRAWN") withdrawn++;
    else if (p.lifecycle === "PENDING") pendingEvents++;
    else postedEvents++;
    proposals.push({ key, rows: g, projection: p });
  }

  console.log(`\n  observations proposed            : ${eligible.length}`);
  console.log(`  logical events proposed          : ${groups.size}`);
  console.log(`    multi-observation events       : ${multi.length}`);
  console.log(`    single-observation events      : ${single.length}`);
  console.log(`    ...POSTED                      : ${postedEvents}`);
  console.log(`    ...PENDING (in flight)         : ${pendingEvents}`);
  console.log(`    ...WITHDRAWN (pending, gone)   : ${withdrawn}`);
  console.log(`  ✓ observations = ${multi.reduce((s, g) => s + g.length, 0) + single.length} (${multi.length} chains × 2 + ${single.length} singles)`);

  console.log(`\n  rows refused, by reason:`);
  if (refusals.size === 0) console.log(`    (none)`);
  for (const [why, ids] of refusals) {
    console.log(`    ${String(ids.length).padStart(4)}  ${why}`);
    for (const id of ids.slice(0, 3)) {
      const r = rows.find((x) => x.id === id)!;
      console.log(`          ${id} ${iso(r.date)} ${r.amount} ${JSON.stringify(r.merchant).slice(0, 30)}`);
    }
  }
  console.log(`  ⚠️ a refusal is NOT a dropped row — it becomes its own single-observation`);
  console.log(`     event, which is the honest outcome when a predecessor cannot be found.`);

  // Every eligible row must land in exactly one event.
  const linked = new Set<string>();
  for (const g of groups.values()) for (const r of g) {
    if (linked.has(r.id)) {
      console.error(`\n  ✗ STOP — row ${r.id} would be linked to more than one event.`);
      process.exit(1);
    }
    linked.add(r.id);
  }
  console.log(`\n  ${linked.size === eligible.length ? "✓" : "✗"} every eligible row lands in exactly one event (${linked.size}/${eligible.length})`);

  // Examples the report asks for.
  console.log(`\n  PENDING → POSTED examples:`);
  for (const p of proposals.filter((x) => x.rows.length > 1).slice(0, 4)) {
    const pre = p.rows.find((r) => r.pending)!, post = p.rows.find((r) => !r.pending)!;
    console.log(`    ${JSON.stringify(post.merchant).slice(0, 28).padEnd(30)} ${pre.amount} · posting ${iso(pre.date)}→${iso(post.date)} · economic ${iso(p.projection.economicDate)} (pinned) · ${p.projection.lifecycle}`);
  }
  console.log(`  WITHDRAWN-PENDING examples:`);
  for (const p of proposals.filter((x) => x.projection.lifecycle === "WITHDRAWN").slice(0, 4)) {
    const r = p.rows[0];
    console.log(`    ${JSON.stringify(r.merchant).slice(0, 28).padEnd(30)} ${r.amount} · ${iso(r.date)} · tombstoned ${iso(r.deletedAt!)} · never posted`);
  }

  const fp = createHash("sha256")
    .update(proposals.map((p) => `${p.key}|${p.rows.map((r) => r.id).sort().join(",")}|${p.projection.lifecycle}`).sort().join("\n"))
    .digest("hex").slice(0, 16);
  console.log(`\n  backfill fingerprint: ${fp} (${proposals.length} events)`);

  // ── Idempotence check ────────────────────────────────────────────────────
  const already = await db.transactionObservation.count();
  if (already > 0) {
    const missing = [];
    for (const g of groups.values()) for (const r of g) {
      const key = observationKey({
        provider: providerOf(r), financialAccountId: r.financialAccountId!,
        providerRowId: r.plaidTransactionId ?? r.externalTransactionId, transactionId: r.id,
        lifecycle: r.pending ? "PENDING" : "POSTED", amount: r.amount,
        postingDate: r.date, economicDate: r.economicDate as Date,
      });
      const hit = await db.transactionObservation.findUnique({ where: { observationKey: key }, select: { id: true } });
      if (!hit) missing.push(r.id);
    }
    if (missing.length === 0) {
      console.log(`\n  ✓ IDEMPOTENT — all ${eligible.length} observations already exist. Nothing to do.\n`);
      await db.$disconnect();
      return;
    }
    console.log(`\n  partial backfill detected: ${missing.length} observations missing.`);
  }

  if (!apply) {
    console.log(`\n  Dry run — nothing written. Re-run with --apply to write.\n`);
    await db.$disconnect();
    return;
  }

  // ── Apply, in bounded transactions ───────────────────────────────────────
  let events = 0, obs = 0;
  const entries = [...groups.entries()];
  for (let i = 0; i < entries.length; i += BATCH) {
    const chunk = entries.slice(i, i + BATCH);
    await db.$transaction(async (tx) => {
      for (const [, g] of chunk) {
        const facts: ObservationFacts[] = g.map((r) => ({
          observedAt: r.createdAt,
          lifecycle: (r.pending ? "PENDING" : "POSTED") as "PENDING" | "POSTED",
          amount: r.amount, postingDate: r.date, economicDate: r.economicDate as Date,
          liveTransactionId: r.deletedAt ? null : r.id,
        }));
        const p = projectEvent(facts);
        const ev = await tx.transactionEvent.create({
          data: {
            financialAccountId: g[0].financialAccountId!,
            lifecycle: p.lifecycle, economicDate: p.economicDate,
            currentAmount: p.currentAmount, currentTransactionId: p.currentTransactionId,
            firstObservedAt: p.firstObservedAt, lastObservedAt: p.lastObservedAt,
            firstPendingObservedAt: p.firstPendingObservedAt, postedObservedAt: p.postedObservedAt,
            observationCount: p.observationCount,
          },
          select: { id: true },
        });
        events++;
        for (const r of g) {
          await tx.transactionObservation.create({
            data: {
              eventId: ev.id, transactionId: r.id, financialAccountId: r.financialAccountId!,
              provider: providerOf(r),
              providerRowId: r.plaidTransactionId ?? r.externalTransactionId,
              providerPendingRef: r.pendingTransactionRef,
              observedAt: r.createdAt,
              lifecycle: r.pending ? "PENDING" : "POSTED",
              amount: r.amount, postingDate: r.date, economicDate: r.economicDate as Date,
              authorizedAt: r.authorizedAt,
              observationKey: observationKey({
                provider: providerOf(r), financialAccountId: r.financialAccountId!,
                providerRowId: r.plaidTransactionId ?? r.externalTransactionId, transactionId: r.id,
                lifecycle: r.pending ? "PENDING" : "POSTED", amount: r.amount,
                postingDate: r.date, economicDate: r.economicDate as Date,
              }),
            },
          });
          obs++;
          await tx.transaction.update({ where: { id: r.id }, data: { transactionEventId: ev.id } });
        }
      }
    }, { timeout: 120_000 });
    console.log(`    …${Math.min(i + BATCH, entries.length)}/${entries.length} events`);
  }
  console.log(`\n  APPLIED — ${events} events, ${obs} observations.\n`);
  await db.$disconnect();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
