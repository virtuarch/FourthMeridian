/**
 * lib/liquidity/restricted-cash-history-label.test.ts   (FIN-005 part 1)
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/liquidity/restricted-cash-history-label.test.ts
 *
 * The liquidity history and the AI's historical cash count RESTRICTED cash (HSA,
 * retirement cash); "Available now" does not. Until a `restrictedCash` column
 * exists (part 2), the history is honestly labelled ALL_CASH, and no change is
 * ever stated between it and the current unrestricted figure. Synthetic fixtures.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Snapshot } from "@/types";
import type { AccountsSectionData } from "@/lib/ai/types";
import {
  ALL_CASH_CHANGE_WITHHELD_MESSAGE, ALL_CASH_HISTORY_AI_NOTE, CASH_HISTORY_BASIS_PRESENTATION,
  allCashChangeComparableToCurrent, clipCashHistory,
} from "./cash-history";
import { LiquidityBalanceHistory } from "@/components/space/widgets/liquidity/LiquidityBalanceHistory";
import { LiquidityHero } from "@/components/space/widgets/liquidity/LiquidityHero";
import { projectSnapshotSection } from "@/lib/ai/assemblers/snapshot";
import { projectBriefPackage, type BriefInputs } from "@/lib/ai/brief/package";
import { BRIEF_SYSTEM_PROMPT } from "@/lib/ai/brief/prompt";

const checks: string[] = [];
const ok = (label: string) => checks.push(label);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const TODAY = "2026-03-31";
const day = (i: number) => new Date(Date.UTC(2026, 1, 20 + i)).toISOString().slice(0, 10); // 2026-02-20 … 2026-03-31
const DAYS = Array.from({ length: 40 }, (_, i) => day(i));
// Checking grows; the stored series is ALL cash (an HSA balance inside totalCash).
const snap = (date: string, i: number): Snapshot => ({
  date, isEstimated: i < 39, totalCash: 6_000 + i * 25, totalSavings: 1_000, totalInvestments: 2_000, totalCrypto: 0,
  totalDebt: 500, totalAssets: 9_000 + i * 25, netWorth: 8_500 + i * 25, netLiquid: 6_500 + i * 25, cashOnHand: 6_000 + i * 25,
} as Snapshot);
const SNAPS = DAYS.map(snap);

// ── §1 the chart says what it is ─────────────────────────────────────────────
{
  const slice = clipCashHistory(SNAPS, TODAY, null, "USD")!;
  assert.equal(slice.basis, "ALL_CASH");
  const html = renderToStaticMarkup(createElement(LiquidityBalanceHistory, { history: slice, currency: "USD", asOf: TODAY, compareTo: null }));
  const t = text(html);
  const p = CASH_HISTORY_BASIS_PRESENTATION.ALL_CASH;
  assert.equal(p.label, "All cash (incl. restricted)");
  assert.ok(t.includes(p.label), "the title / legend names the basis");
  assert.ok(t.includes("including restricted cash such as HSA and retirement cash") && t.includes("“Available now” excludes restricted cash"),
    "the basis note explains the two are not the same measure");
  assert.ok(/data-cash-history-basis="ALL_CASH"/.test(html), "the ALL_CASH basis is surfaced on the chart");
  assert.ok(!/accessible/i.test(html), "no shared 'accessible' wording on the history chart");
  // Empty history still labels truthfully.
  const empty = text(renderToStaticMarkup(createElement(LiquidityBalanceHistory, { history: null, currency: "USD", asOf: TODAY, compareTo: null })));
  assert.ok(empty.includes(p.label) && !/accessible/i.test(empty), "no history ⇒ still labelled, still not 'accessible'");
  ok("§1 chart: 'All cash (incl. restricted)' title + basis note; ALL_CASH surfaced; no 'accessible' wording");
}

// ── §2 the hero never prints an all-cash change beside unrestricted cash ─────
{
  assert.equal(allCashChangeComparableToCurrent(0), true, "no restricted cash ⇒ the bases coincide");
  assert.equal(allCashChangeComparableToCurrent(undefined), true, "no restricted figure supplied ⇒ as before");
  assert.equal(allCashChangeComparableToCurrent(1_234.56), false, "restricted cash ⇒ not comparable");
  const hero = (deltaBasisDiffers: boolean, deltaBasisReason?: "REACHABLE" | "RESTRICTED_CASH") => text(renderToStaticMarkup(createElement(LiquidityHero, {
    cashNow: 5_000, reachableSoon: 0, sharePctNow: null, sourceCount: 2, coverage: null, estimated: false, currency: "USD",
    asOf: TODAY, today: TODAY, historical: false, change: { abs: 975, pct: 13.7, fromLabel: "Feb 20, 2026" },
    deltaBasisDiffers, ...(deltaBasisReason ? { deltaBasisReason } : {}),
    envelope: { completeness: "complete", warnings: [] }, verdict: null, verdictAsOf: null, redactions: 0,
  } as never)));
  const withRestricted = hero(true, "RESTRICTED_CASH");
  assert.ok(!/975|13\.7/.test(withRestricted), "no all-cash delta beside the unrestricted figure");
  assert.ok(/tracks all cash, including restricted cash this figure excludes/.test(withRestricted), "…and the reason is said");
  assert.ok(/975/.test(hero(false)), "no restricted cash ⇒ the delta renders as before");
  const ws = src("../../components/space/widgets/liquidity/LiquidityWorkspace.tsx");
  assert.ok(/\|\| !allCashChangeComparableToCurrent\(classification\.totalRestrictedCash\)/.test(ws), "the workspace defers the delta on restricted cash");
  ok("§2 hero: all-cash delta withheld with a reason whenever restricted cash exists");
}

// ── §3 the AI payload carries the basis ──────────────────────────────────────
{
  const section = projectSnapshotSection(SNAPS, "full")!;
  assert.equal(section.liquidBasis, "ALL_CASH", "the snapshot section states its cash basis");
  assert.equal(section.liquidBasisNote, ALL_CASH_HISTORY_AI_NOTE);
  assert.ok(/INCLUDING restricted cash/.test(section.liquidBasisNote!) && /never subtract one from the other/.test(section.liquidBasisNote!),
    "the note forbids comparing it with current unrestricted liquid");
  assert.equal(section.latest!.liquid, SNAPS.at(-1)!.totalCash + SNAPS.at(-1)!.totalSavings, "the figure itself is unchanged (no data change)");
  const brief = projectSnapshotSection(SNAPS, "brief")!;
  assert.equal(brief.liquidBasis, "ALL_CASH", "…at the brief scope too");
  ok("§3 AI snapshot section: liquidBasis ALL_CASH + note; figures unchanged");
}

// ── §4 no unrestricted-vs-all-cash change is computed ────────────────────────
{
  const acc = (totalRestrictedCash: number | undefined) => ({
    totalLiquid: 4_000, totalLiabilities: 500, netWorth: 8_000, totalInvestments: 2_000, totalDigitalAssets: 0,
    ...(totalRestrictedCash !== undefined ? { totalRestrictedCash } : {}),
    redactedCount: 0, totalsUnconverted: false, accounts: [],
    counts: { liquid: 2, investments: 1, digitalAssets: 0, realAssets: 0, liabilities: 1 },
  } as unknown as AccountsSectionData);
  const inputs = (over: Partial<BriefInputs>): BriefInputs => ({
    asOf: TODAY, today: TODAY, now: new Date(`${TODAY}T12:00:00.000Z`), currency: "USD",
    accounts: null, transactions: null, snapshot: projectSnapshotSection(SNAPS, "full"), holdings: null,
    assessment: null, memories: [], recentActivity: null, ...over,
  } as BriefInputs);

  const clean = projectBriefPackage(inputs({ accounts: acc(0) }));
  assert.ok(clean.recentChanges.w1?.liquid && clean.recentChanges.m1?.liquid && clean.recentChanges.d1?.liquid,
    "no restricted cash ⇒ the liquid deltas are measured, as before");
  assert.deepEqual(projectBriefPackage(inputs({ accounts: acc(undefined) })).recentChanges, clean.recentChanges,
    "no restricted figure ⇒ byte-identical");

  // S2 — the fail-open edge (`totalRestrictedCash` absent ⇒ comparable) is sound ONLY
  // because today's liquid figure comes from the SAME accounts summary. A missing
  // summary must therefore yield NO current liquid figure to pair a change with…
  const noAccounts = projectBriefPackage(inputs({ accounts: null }));
  assert.equal(noAccounts.currentState.basis, "CURRENT_ACCOUNTS");
  assert.equal(noAccounts.currentState.liquid, null, "no accounts summary ⇒ no currentState.liquid (nothing to pair a change with)");
  // …and the two must keep reading the one `acc`: no other source for current liquid.
  const pkg = src("../ai/brief/package.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  assert.ok(/liquid:\s+moneyOrNull\(acc\?\.totalLiquid\)/.test(pkg), "current liquid is the accounts summary's totalLiquid");
  assert.ok(/allCashChangeComparableToCurrent\(acc\?\.totalRestrictedCash\)/.test(pkg), "…and the comparability test reads the SAME acc");
  assert.equal((pkg.match(/currentState\.liquid\s*=|liquid:\s+moneyOrNull\(/g) ?? []).length, 2,
    "exactly two currentState.liquid sources: CURRENT (acc) and HISTORICAL (the snapshot point, one basis)");

  const restricted = projectBriefPackage(inputs({ accounts: acc(3_000) }));
  assert.equal(restricted.currentState.liquid, 4_000, "currentState.liquid is the unrestricted figure");
  for (const k of ["d1", "w1", "m1"] as const) {
    const w = restricted.recentChanges[k]!;
    assert.equal(w.liquid, undefined, `${k}: no liquid delta beside unrestricted liquid`);
    assert.equal(w.unavailable?.liquid, ALL_CASH_CHANGE_WITHHELD_MESSAGE, `${k}: withheld with the reason`);
    assert.ok(w.netWorth && w.debt, `${k}: other metrics untouched`);
  }
  const retro = projectBriefPackage(inputs({ asOf: DAYS[35], accounts: acc(3_000) }));
  assert.equal(retro.currentState.basis, "HISTORICAL_SNAPSHOT");
  assert.ok(retro.recentChanges.w1 === undefined || retro.recentChanges.w1.unavailable?.liquid === undefined,
    "a retrospective Brief reads both from the snapshot (one basis) — never withheld for restricted cash");
  assert.ok(/includes restricted cash \(HSA, retirement\) that today's liquid figure excludes/.test(BRIEF_SYSTEM_PROMPT),
    "the Brief instruction says how to disclose it");

  // The history chart's hero delta and the AI change blocks are all-cash vs all-cash;
  // nothing subtracts current unrestricted liquid from a snapshot's liquid.
  for (const f of ["../ai/assemblers/snapshot.ts", "../ai/brief/package.ts", "../../components/space/widgets/liquidity/LiquidityWorkspace.tsx"]) {
    const s = src(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    assert.ok(!/totalLiquid\s*-|-\s*[\w.?]*totalLiquid/.test(s), `${f}: no arithmetic between totalLiquid and history`);
  }
  ok("§4 Brief: liquid change withheld beside unrestricted liquid when restricted cash exists; no cross-basis arithmetic");
}

for (const c of checks) console.log(`  ✓ ${c}`);
console.log(`restricted-cash-history-label (FIN-005 part 1): ${checks.length} checks passed`);
