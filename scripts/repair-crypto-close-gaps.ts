/**
 * scripts/repair-crypto-close-gaps.ts
 *
 * CRYPTO-LATCH-3 — FIND, AND OPTIONALLY REPAIR, MISSING RAW_CLOSE DAYS FOR HELD
 * CRYPTO ASSETS.
 *
 * DRY RUN BY DEFAULT. Without `--apply` this is strictly read-only: it reports
 * what is missing and exits. Repair writes only with `--apply`, and that is an
 * authorized operator action, never something a refresh or a cron does on its
 * own behalf at this breadth.
 *
 *     # report only (read-only, safe anywhere)
 *     npx dotenv -e .env.local -- npx tsx scripts/repair-crypto-close-gaps.ts
 *
 *     # bounded window
 *     npx dotenv -e .env.local -- npx tsx scripts/repair-crypto-close-gaps.ts \
 *       --from 2026-09-21 --to 2026-09-29
 *
 *     # repair (WRITES — requires explicit authorization)
 *     npx dotenv -e .env.local -- npx tsx scripts/repair-crypto-close-gaps.ts \
 *       --from 2026-09-21 --to 2026-09-29 --apply
 *
 * Exit codes: 0 = no gaps (or repaired) · 1 = gaps remain · 2 = failure.
 *
 * ── Why this reuses backfillPricesForInstruments rather than fetching ───────
 * Because that module is already the ONE acquisition implementation and already
 * has every property a historical repair must have. Verified against its
 * contract before writing this script, rather than assumed:
 *
 *   · RAW_CLOSE semantics preserved — it writes that basis and no other.
 *   · Never fabricates — no interpolation, no carry; a day the vendor does not
 *     serve stays missing.
 *   · Reports provider failures — `outcomes` classifies them (V26-PRICE-4), so
 *     a run throttled into silence does not look like a complete one.
 *   · Idempotent and missing-only — coverage-driven planning (V26-PRICE-3), so
 *     a fully covered instrument costs ZERO network calls and a re-run is a
 *     no-op. Interior gaps are planned like any other, which is the property
 *     this repair depends on and which the old edge-arithmetic lacked.
 *   · Insert-only via `priceArchive.writeBatch` — it cannot overwrite a
 *     stronger authority, and closed dates only (`assertClosedDateISO`).
 *
 * So there is nothing to add to acquisition. What was missing was DETECTION and
 * an explicit entry point — which is all this script is.
 *
 * ── The gap this exists for ─────────────────────────────────────────────────
 * The 2026-10-01 incident left 2026-09-21..2026-09-29 absent from the BTC / ETH
 * / SOL RAW_CLOSE series. The latch repair (CRYPTO-LATCH-1) restores only the
 * valuation's own walk-back window, deliberately — it is a valuation
 * prerequisite, not a history tool, and widening it would make every refresh
 * pay for unbounded acquisition. Closing an older hole is this script's job.
 */

import { db } from "@/lib/db";
import { PriceBasis } from "@prisma/client";
import { priceArchive } from "@/lib/prices/archive";
import { backfillPricesForInstruments } from "@/lib/prices/backfill";
import { yesterdayUTCISO, minusDaysISO } from "@/lib/prices/config";
import { nativeAssetForChain } from "@/lib/crypto/native-asset";
import { lookupCryptoInstrumentId } from "@/lib/crypto/crypto-price-window";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Every ISO date in [from, to] inclusive. The archive is daily for crypto —
 *  there is no market calendar to honour, unlike equities. */
function daysBetween(fromISO: string, toISO: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${fromISO}T00:00:00Z`); d <= new Date(`${toISO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Collapse a sorted date list into inclusive ranges, so output is readable. */
function toRanges(dates: string[]): string[] {
  const ranges: string[] = [];
  let start: string | null = null;
  let prev: string | null = null;
  const nextOf = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  for (const d of dates) {
    if (start === null) { start = d; prev = d; continue; }
    if (prev !== null && d === nextOf(prev)) { prev = d; continue; }
    ranges.push(start === prev ? start : `${start}..${prev}`);
    start = d; prev = d;
  }
  if (start !== null) ranges.push(start === prev ? start : `${start}..${prev}`);
  return ranges;
}

async function main(): Promise<void> {
  const toISO = flag("--to") ?? yesterdayUTCISO();
  // A 30-day default keeps an unparameterised run bounded and cheap.
  const fromISO = flag("--from") ?? minusDaysISO(toISO, 30);
  if (!ISO.test(fromISO) || !ISO.test(toISO)) {
    console.error(`usage error: --from/--to must be YYYY-MM-DD (got ${fromISO}..${toISO})`);
    process.exit(2);
  }
  if (fromISO > toISO) {
    console.error(`usage error: --from (${fromISO}) is after --to (${toISO})`);
    process.exit(2);
  }
  // The archive holds CLOSED dates only; asking beyond yesterday is asking for a
  // row it would refuse to store.
  const yesterday = yesterdayUTCISO();
  const clampedTo = toISO > yesterday ? yesterday : toISO;
  if (clampedTo !== toISO) {
    console.log(`note: --to ${toISO} clamped to ${clampedTo} (the archive stores closed dates only)`);
  }

  console.log(`crypto RAW_CLOSE gap ${APPLY ? "REPAIR" : "REPORT (dry run — nothing will be written)"}`);
  console.log(`window ${fromISO}..${clampedTo}\n`);

  // HELD assets only — the same rule the rest of the system uses: "Bitcoin is
  // included because it is held, not because it is Bitcoin."
  const chains = await db.financialAccount.findMany({
    where:    { walletChain: { not: null }, deletedAt: null },
    select:   { walletChain: true },
    distinct: ["walletChain"],
  });
  const assets = [...new Map(
    chains.map((c) => nativeAssetForChain(c.walletChain))
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .map((a) => [a.assetKey, a] as const),
  ).values()].sort((a, b) => a.symbol.localeCompare(b.symbol));

  if (assets.length === 0) {
    console.log("no held crypto assets — nothing to check.");
    process.exit(0);
  }

  const expected = daysBetween(fromISO, clampedTo);
  let gapsRemain = 0;
  let totalInserted = 0;

  for (const asset of assets) {
    const instrumentId = await lookupCryptoInstrumentId(asset, db);
    if (!instrumentId) {
      console.log(`${asset.symbol.padEnd(5)} NO INSTRUMENT — not priceable, nothing to acquire against`);
      continue;
    }
    const have = new Set(
      ((await priceArchive.readRange?.([instrumentId], PriceBasis.RAW_CLOSE, fromISO, clampedTo)) ?? [])
        .map((r) => r.dateISO),
    );
    const missing = expected.filter((d) => !have.has(d));

    if (missing.length === 0) {
      console.log(`${asset.symbol.padEnd(5)} COMPLETE — ${have.size}/${expected.length} day(s) present`);
      continue;
    }
    console.log(
      `${asset.symbol.padEnd(5)} ${missing.length} missing of ${expected.length}: ${toRanges(missing).join(", ")}`,
    );

    if (!APPLY) { gapsRemain += missing.length; continue; }

    // Bounded to the requested window. Missing-only planning means the request
    // reaches the vendor for the gap and for nothing else.
    const r = await backfillPricesForInstruments([instrumentId], {
      apply:       true,
      forceWindow: { fromISO, toISO: clampedTo },
      onProgress:  (line) => console.log(`      ${line}`),
    });
    totalInserted += r.inserted;
    const outcomes = Object.entries(r.outcomes).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(", ");
    console.log(`      acquired ${r.inserted} row(s); outcomes ${outcomes || "none"}`);

    // RE-READ, never trust the write count: a vendor can insert rows that still
    // do not close the gap (its own depth floor, a delisted tail, a throttle).
    const after = new Set(
      ((await priceArchive.readRange?.([instrumentId], PriceBasis.RAW_CLOSE, fromISO, clampedTo)) ?? [])
        .map((r2) => r2.dateISO),
    );
    const still = expected.filter((d) => !after.has(d));
    gapsRemain += still.length;
    console.log(still.length === 0
      ? `      ✓ ${asset.symbol} window is now COMPLETE`
      : `      ⚠ ${still.length} day(s) STILL missing: ${toRanges(still).join(", ")} — the vendor does not serve them`);
  }

  console.log(
    `\n${APPLY ? `repair complete — ${totalInserted} row(s) written; ` : "dry run — nothing written; "}` +
    `${gapsRemain} day-gap(s) ${gapsRemain === 0 ? "remaining" : "remaining (see above)"}`,
  );
  if (!APPLY && gapsRemain > 0) {
    console.log("re-run with --apply to acquire them (an authorized write).");
  }
  process.exit(gapsRemain > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("repair-crypto-close-gaps failed:", e instanceof Error ? e.message : e);
  process.exit(2);
});
