/**
 * lib/history/holding-series.ts
 *
 * V27-D — the deepest level: one holding, over time.
 *
 * ── Identity (D1) ────────────────────────────────────────────────────────────
 * A holding is identified by (accountId, instrumentId) — NEVER by symbol. A
 * ticker is a label an issuer can reassign; the same symbol in two accounts is
 * two positions with two cost bases and two ownership histories. Symbol is
 * carried for display and decides nothing.
 *
 * ── One spine, two reads (D2) ────────────────────────────────────────────────
 *   historical dates  `historicalHoldingsForWindow` — the ONE holdings authority,
 *                     the SAME call the account level made, so a holding's value
 *                     IS its share of the account's by construction
 *   the present       `getCurrentPositions` — the canonical latest-per-pair read
 *                     on the SAME PositionObservation spine, so identity does not
 *                     change at the boundary
 *   crypto            `valueCryptoDay` — a wallet's position IS the wallet
 *
 * Precedence rule 1 again: on the present date the archive's close is not the
 * quote the account balance was struck at, so the observation wins — the same
 * correction Slice C's corpus forced one level up.
 *
 * ── Ownership episodes (D3) ──────────────────────────────────────────────────
 * IMPLEMENTED, not refused. A position sold and re-bought is TWO episodes, and
 * the gap between them is a real "not held" period rather than a line bridging
 * across it. Episodes are derived from the licensing runs the ownership engine
 * already resolved, so nothing here decides ownership.
 *
 * NO PERSISTENCE. READ-ONLY.
 */

import { db } from "@/lib/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import { historicalHoldingsForWindow } from "@/lib/investments/historical-holdings";
import { getCurrentPositions } from "@/lib/investments/current-positions";
import { round2 } from "@/lib/perspective-engine/reconciliation.core";
import { isoDate, truncDateUTC } from "@/lib/snapshots/backfill-core";
import { eachDate } from "./account-series";
import {
  extendBreadcrumb,
  type HistoricalAccountNode, type HistoricalCrumb,
  type HistoricalHoldingNode, type HistoricalScope, type HistoricalSeriesPoint,
} from "./historical-node.core";

type Client = PrismaClient | Prisma.TransactionClient;

export interface HoldingSeriesArgs {
  spaceId:  string;
  account:  Pick<HistoricalAccountNode, "accountId" | "accountType" | "dateISO" | "fromISO" | "toISO" | "currency" | "breadcrumb" | "displayedValue">;
  client?:  Client;
}

/**
 * The holdings composing one account on its selected date, each with a series.
 *
 * `null` when the account type HAS no holding level (a checking account is not a
 * portfolio) — distinct from an empty list, which would claim the level exists
 * and is empty.
 */
export async function accountHoldingNodes(
  args: HoldingSeriesArgs,
): Promise<HistoricalHoldingNode[] | null> {
  const { account } = args;
  if (account.accountType !== "investment") return null;

  const client = args.client ?? db;
  const dates = eachDate(account.fromISO, account.toISO);
  const todayISO = isoDate(truncDateUTC(new Date()));

  const byDate = await historicalHoldingsForWindow({
    financialAccountId: account.accountId, dates, client,
    holdConstantBeforeEarliest: true, excludeDigitalAssetAccounts: true,
  });

  // The present, from the same spine and the same identity.
  const present = account.toISO >= todayISO
    ? await getCurrentPositions({ financialAccountId: account.accountId }, { client })
    : null;

  // ── The instrument set is the UNION over the window ────────────────────────
  //
  // Taking it from the selected date alone would silently drop everything sold
  // earlier in the window — the chart would show a portfolio that never shrank.
  const identity = new Map<string, { symbol: string | null; assetClass: string; isCash: boolean }>();
  for (const d of dates) {
    for (const h of byDate.get(d)?.held ?? []) {
      if (!identity.has(h.instrumentId)) {
        identity.set(h.instrumentId, { symbol: null, assetClass: "UNKNOWN", isCash: false });
      }
    }
  }
  for (const r of present?.rows ?? []) {
    identity.set(r.instrumentId, { symbol: r.symbol, assetClass: r.assetClass, isCash: r.isCash });
  }
  // Display identity for instruments that only ever appear historically.
  const missing = [...identity].filter(([, v]) => v.symbol === null).map(([k]) => k);
  if (missing.length > 0) {
    const rows = await client.instrument.findMany({
      where: { id: { in: missing } },
      select: { id: true, tickerSymbol: true, name: true, assetClass: true },
    });
    for (const r of rows) {
      const cur = identity.get(r.id);
      if (cur) identity.set(r.id, { ...cur, symbol: r.tickerSymbol ?? r.name, assetClass: r.assetClass ?? "UNKNOWN" });
    }
  }

  const presentByInstrument = new Map((present?.rows ?? []).map((r) => [r.instrumentId, r]));

  const nodes: HistoricalHoldingNode[] = [];
  for (const [instrumentId, id] of identity) {
    const point = (d: string): HistoricalSeriesPoint => {
      if (d >= todayISO) {
        const p = presentByInstrument.get(instrumentId);
        // Absent from the present read = no longer held. A gap, not a zero.
        if (!p) return { dateISO: d, value: null, basis: "observed", unavailableReason: "NOT_HELD" };
        if (p.reportingValue == null) {
          return { dateISO: d, value: null, basis: "observed", unavailableReason: "NO_DEFENSIBLE_VALUE" };
        }
        return { dateISO: d, value: round2(p.reportingValue), basis: "observed" };
      }
      const set = byDate.get(d);
      const held = set?.held.find((h) => h.instrumentId === instrumentId);
      if (!held) {
        // The ownership engine's OWN reason — never re-decided here.
        const ex = set?.excluded.find((e) => e.instrumentId === instrumentId);
        return { dateISO: d, value: null, basis: "reconstructed", unavailableReason: ex?.reasonCode ?? "NOT_HELD" };
      }
      if (held.reportingValue == null) {
        return { dateISO: d, value: null, basis: "reconstructed", unavailableReason: "NO_DEFENSIBLE_VALUE" };
      }
      return { dateISO: d, value: round2(held.reportingValue), basis: "reconstructed" };
    };

    const series = dates.map(point);
    const at = series.find((p) => p.dateISO === account.dateISO) ?? point(account.dateISO);
    const heldAt = byDate.get(account.dateISO)?.held.find((h) => h.instrumentId === instrumentId);
    const presentAt = account.dateISO >= todayISO ? presentByInstrument.get(instrumentId) : undefined;

    const quantity = presentAt?.quantity ?? heldAt?.quantity ?? null;
    const value = at.value;
    const unitPrice = quantity != null && quantity !== 0 && value != null
      ? round2(value / quantity) : null;

    const episodes = ownershipEpisodes(series);

    nodes.push({
      nodeType: "holding",
      id: `holding:${account.accountId}:${instrumentId}`,
      label: id.symbol ?? instrumentId,
      accountId: account.accountId,
      instrumentId,
      symbol: id.symbol,
      assetClass: id.isCash ? "CASH" : id.assetClass,
      quantity, unitPrice,
      dateISO: account.dateISO, fromISO: account.fromISO, toISO: account.toISO,
      currency: account.currency,
      displayedValue: value,
      // A holding is a LEAF. It has no children, so it explains nothing — which
      // is not the same as failing to explain something.
      explainedValue: null,
      unattributedObservedAmount: null,
      reconciliation: value == null ? "UNAVAILABLE" : "EXACT",
      assertable: value != null,
      unavailableReason: at.unavailableReason ?? null,
      provenance: {
        basis: at.basis,
        tier: at.basis === "observed" ? "observed" : (heldAt?.tier ?? "unknown"),
        supportedFromISO: episodes[0]?.fromISO ?? null,
        supportedToISO: episodes.length > 0 ? episodes[episodes.length - 1].toISO : null,
        note: episodes.length > 1
          // The one fact a single from/to pair cannot express.
          ? `Held in ${episodes.length} separate periods within this window.`
          : heldAt?.reason ?? null,
      },
      breadcrumb: extendBreadcrumb(account.breadcrumb, {
        id: `holding:${account.accountId}:${instrumentId}`,
        label: id.symbol ?? instrumentId,
        nodeType: "holding",
      } satisfies HistoricalCrumb),
      components: [],
      drilldown: { available: false, reason: "HOLDING_IS_THE_DEEPEST_LEVEL" },
      series,
      ownershipEpisodes: episodes,
    });
  }

  // Value-descending, then instrument id — the same order A10 uses, so the
  // drill-down and the holdings table never disagree about what is "first".
  nodes.sort((a, b) =>
    (b.displayedValue ?? -Infinity) - (a.displayedValue ?? -Infinity) ||
    (a.instrumentId ?? "").localeCompare(b.instrumentId ?? ""));
  return nodes;
}

/**
 * The selected date's SCOPE, projected from the ownership engine's own exclusion
 * reasons. Nothing is classified here — each reason is counted where the
 * authority already put it.
 */
export async function accountScopeForDate(
  args: HoldingSeriesArgs,
): Promise<HistoricalScope | null> {
  const { account } = args;
  if (account.accountType !== "investment") return null;
  const client = args.client ?? db;
  const byDate = await historicalHoldingsForWindow({
    financialAccountId: account.accountId, dates: [account.dateISO], client,
    holdConstantBeforeEarliest: true, excludeDigitalAssetAccounts: true,
  });
  const set = byDate.get(account.dateISO);
  if (!set) return null;
  const count = (code: string) => set.excluded.filter((e) => e.reasonCode === code).length;
  return {
    heldValued:         set.held.filter((h) => h.reportingValue != null).length,
    heldUnavailable:    set.held.filter((h) => h.reportingValue == null).length,
    notYetOwned:        count("NOT_YET_OWNED"),
    alreadyClosed:      count("OWNERSHIP_CLOSED"),
    ownershipUncertain: count("OWNERSHIP_UNKNOWN"),
    excludedArtifact:   count("NO_OWNERSHIP_EVIDENCE"),
  };
}

/**
 * D3 — the runs of dates where the position was actually held.
 *
 * Two episodes mean sold-and-rebought, and the gap between them is a real "not
 * held" period. Collapsing them into one first→last span would draw a line
 * across a stretch when nothing was owned, which is the specific lie the
 * historical engine exists to avoid.
 */
export function ownershipEpisodes(
  series: readonly HistoricalSeriesPoint[],
): { fromISO: string; toISO: string }[] {
  const out: { fromISO: string; toISO: string }[] = [];
  for (const p of series) {
    // NOT_HELD and its ownership-engine variants end an episode. A held position
    // the engine could not VALUE does not — we know it was owned, only not what
    // it was worth, and those are different absences.
    const held = p.value != null || (p.unavailableReason === "NO_DEFENSIBLE_VALUE");
    if (!held) continue;
    const last = out[out.length - 1];
    if (last && isNextDay(last.toISO, p.dateISO)) last.toISO = p.dateISO;
    else out.push({ fromISO: p.dateISO, toISO: p.dateISO });
  }
  return out;
}

function isNextDay(prevISO: string, nextISO: string): boolean {
  const d = new Date(`${prevISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10) === nextISO;
}
