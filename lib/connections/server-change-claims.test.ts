/**
 * lib/connections/server-change-claims.test.ts  (PB-8c — follow-up to PB-8 / PB-8b)
 *
 * PB-8b gated the CLIENT hero / story deltas with `changeComparability`; the
 * SERVER-side change claims still subtracted across the balance-history floor:
 *   1. the AI snapshot changes (`canonicalChange` / `liabilitiesChange`, the
 *      orientation's `changeThisMonth`, the history tool's `change` block) —
 *      what lets the model say "Net worth up $X since …";
 *   2. the Space launcher card's 1M change (`getSpaceNetWorthSummaries`);
 *   3. the Daily Brief's `recentChanges`.
 * Each now runs `gateWindowChange` (= `changeComparability`, the SAME floors
 * from lib/connections/balance-coverage.ts): withheld ⇒ null + a typed reason
 * the consumer renders / discloses; estimated ⇒ the figure, marked. A coverage
 * read that FAILS falls open (as PB-8) and logs one counts-only line.
 *
 * Synthetic fixture shaped like the PB-8b Preview finding (no customer data):
 * 12 debts — 2 walked cards with history since early 2026, 10 debts whose floor
 * is Nov 2, 2026 (4 held flat); comparison day Jun 17, 2026.
 *   §1 AI snapshot (FIRST, per review) — projection, orientation, history tool
 *   §2 Space launcher card
 *   §3 Daily Brief recentChanges (package + loader)
 *   §4 fail-open + counts-only log
 *   §5 wiring pins + audit-snapshot-window-claims understands withheld changes
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/connections/server-change-claims.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Snapshot } from "@/types";
import type { SpaceContext } from "@/lib/space";
import type { FinancialAssessment } from "@/lib/ai/intelligence";
import type { SpaceContext_AI } from "@/lib/ai/types";
import { FinanceDomains } from "@/lib/ai/types";
import { projectSnapshotSection } from "@/lib/ai/assemblers/snapshot";
import { thinCore } from "@/lib/ai/conversation/evidence";
import { changeBlock } from "@/lib/ai/conversation/tools/history";
import { admissibleNetWorthSeries, summarizeNetWorthSeries, type RawSnapshotRow } from "@/lib/data/snapshot-summary.core";
import { projectBriefPackage, type BriefInputs } from "@/lib/ai/brief/package";
import { loadBriefPackage } from "@/lib/ai/brief/load";
import { BRIEF_SYSTEM_PROMPT } from "@/lib/ai/brief/prompt";
import { loadBalanceCoverageBySpace, loadBalanceCoverageFailClosed } from "./balance-coverage";
import {
  balanceCoverageLoadFailureLine, changeUnavailableMessage, gateWindowChange, type BalanceCoverage,
  BALANCE_COVERAGE_UNAVAILABLE, BALANCE_COVERAGE_UNREADABLE_MESSAGE,
} from "./balance-coverage.core";

const checks: string[] = [];
const ok = (label: string) => checks.push(label);

// ── Fixture — the Preview shape ──────────────────────────────────────────────
const FLOOR = "2026-11-02";
const TODAY = "2026-11-03";
const MESSAGE = "Change unavailable: history is partial before Nov 2, 2026";
const COV: BalanceCoverage = {
  liabilityFloors: ["2026-01-05", "2026-02-10", ...Array<string>(10).fill(FLOOR)],
  assetFloors: ["2026-01-05"],
  estimatedLiabilityFloors: Array<string>(4).fill(FLOOR),
};
const COV_COMPLETE: BalanceCoverage = { liabilityFloors: ["2026-01-05", "2026-02-10"], assetFloors: ["2026-01-05"], estimatedLiabilityFloors: [] };
// The same 12 debts, floored early enough that the 1M window opens inside it:
// a held-flat estimate on a reconstructed opening day ⇒ comparable, ESTIMATED.
const COV_EST: BalanceCoverage = {
  liabilityFloors: ["2026-01-05", "2026-02-10", ...Array<string>(10).fill("2026-09-15")],
  assetFloors: ["2026-01-05"],
  estimatedLiabilityFloors: Array<string>(4).fill("2026-09-15"),
};

// Before the floor only the 2 walked cards are in the series; from it all 12.
const CASH = 20_000;
const PRE_DEBT = 12_376.80;
const POST_DEBT = PRE_DEBT + 316_074.35;
const DAYS: { date: string; debt: number; est: boolean }[] = [
  { date: "2026-06-17", debt: PRE_DEBT,        est: true },  // the PB-8b comparison day
  { date: "2026-08-17", debt: 12_100.00,       est: true },
  { date: "2026-10-03", debt: 11_900.00,       est: true },  // the 1M opening (Nov 3 − 1 month)
  { date: "2026-10-27", debt: 11_700.00,       est: true },  // the 1W opening
  { date: "2026-11-01", debt: 11_650.00,       est: true },
  { date: FLOOR,        debt: POST_DEBT - 210, est: true },  // held-flat debts estimated
  { date: TODAY,        debt: POST_DEBT,       est: false }, // the live row
];
const snap = (d: (typeof DAYS)[number]): Snapshot => ({
  date: d.date, netWorth: CASH - d.debt, totalAssets: CASH, totalDebt: d.debt, totalCash: CASH,
  totalSavings: 0, totalInvestments: 0, totalCrypto: 0, cashOnHand: CASH, netLiquid: CASH - d.debt,
  isEstimated: d.est,
});
const ROWS = DAYS.map(snap);

// Every figure a cross-floor change could print, as the model / card would see it.
const crossFloorFigures = (abs: number) => [String(abs), abs.toFixed(2), String(Math.abs(abs)), Math.abs(abs).toFixed(2)];
const carriesNone = (json: string, abs: number) => crossFloorFigures(abs).every((f) => !json.includes(f));

// ── §1 AI snapshot — the most important path (first) ─────────────────────────
{
  const before = projectSnapshotSection(ROWS, "full");
  assert.ok(before?.canonicalChange && before.liabilitiesChange, "pre-fix: both 1M changes are computed across the floor");
  const nwAbs = before.canonicalChange.abs;
  const debtAbs = before.liabilitiesChange.abs;
  assert.ok(Math.abs(debtAbs) > 300_000, "pre-fix: the 'change' is the missing debts arriving");

  const gated = projectSnapshotSection(ROWS, "full", COV)!;
  assert.equal(gated.canonicalChange, null, "net-worth change withheld");
  assert.equal(gated.liabilitiesChange, null, "liabilities change withheld");
  assert.deepEqual(gated.canonicalChangeUnavailable, { reason: "PARTIAL_BALANCE_HISTORY", coveredFrom: FLOOR, message: MESSAGE });
  assert.deepEqual(gated.liabilitiesChangeUnavailable, { reason: "PARTIAL_BALANCE_HISTORY", coveredFrom: FLOOR, message: MESSAGE });
  assert.equal(gated.partialHistory?.before, FLOOR);
  assert.ok(gated.partialHistory!.note.startsWith("History is partial before Nov 2, 2026"), gated.partialHistory!.note);
  assert.ok(/never measure or state a change/i.test(gated.partialHistory!.note));
  const json = JSON.stringify(gated);
  assert.ok(carriesNone(json, nwAbs) && carriesNone(json, debtAbs), "no cross-floor number anywhere in the section");
  // Brief scope carries the identical verdict (it shares the projection).
  const brief = projectSnapshotSection(ROWS, "brief", COV)!;
  assert.equal(brief.canonicalChange, null);
  assert.deepEqual(brief.canonicalChangeUnavailable, gated.canonicalChangeUnavailable);

  // Complete window ⇒ byte-identical to before; no coverage ⇒ byte-identical.
  assert.deepEqual(projectSnapshotSection(ROWS, "full", COV_COMPLETE), before, "complete window unchanged");
  assert.deepEqual(projectSnapshotSection(ROWS, "full", null), before, "no coverage unchanged");

  // Estimated: the 1M opening (Oct 3, reconstructed) is inside the Sep 15 floor.
  const est = projectSnapshotSection(ROWS, "full", COV_EST)!;
  assert.equal(est.canonicalChange?.estimated, true, "net-worth change labelled estimated");
  assert.equal(est.liabilitiesChange?.estimated, true, "liabilities change labelled estimated");
  assert.equal(est.canonicalChange?.abs, before.canonicalChange.abs, "an estimated change keeps its figure");
  assert.ok(!("canonicalChangeUnavailable" in est));
  ok("§1a AI snapshot projection: withheld with reason (exact Preview shape), complete unchanged, estimated labelled, no cross-floor number");

  // The orientation the model reads ("changeThisMonth").
  const ctx = (data: unknown) => ({
    requestedAt: `${TODAY}T12:00:00.000Z`, spaceId: "s", userId: "u", role: "OWNER", agentId: "t",
    resolvedDomains: [FinanceDomains.SNAPSHOT_HISTORY],
    space: { id: "s", name: "Household", type: "PERSONAL", category: "OTHER", reportingCurrency: "USD" },
    domains: { [FinanceDomains.SNAPSHOT_HISTORY]: { domain: FinanceDomains.SNAPSHOT_HISTORY, assembledAt: TODAY, data } },
    signals: [], auditLogId: "t",
  }) as unknown as SpaceContext_AI;
  const orientation = (data: unknown) => (thinCore(ctx(data)) as { netWorthHistory: Record<string, unknown> }).netWorthHistory;
  const o = orientation(gated);
  assert.equal(o.changeThisMonth, null);
  assert.equal(o.changeThisMonthUnavailable, MESSAGE, "the model receives the REASON instead of the number");
  assert.ok(String(o.partialHistory).includes("History is partial before Nov 2, 2026"));
  assert.ok(carriesNone(JSON.stringify(thinCore(ctx(gated))), nwAbs), "no cross-floor number in the orientation");
  const oBefore = orientation(before);
  assert.ok(!("changeThisMonthUnavailable" in oBefore) && !("partialHistory" in oBefore), "complete history: orientation byte-identical");
  ok("§1b AI orientation: changeThisMonth null + changeThisMonthUnavailable = the reason; complete unchanged");

  // The history tool's `change` block, from the PB-8b comparison day (Jun 17).
  const pt = (p: NonNullable<typeof before>["history"][number]) => ({
    date: p.date, netWorth: p.netWorth, liquid: p.liquid, checking: p.cashOnHand,
    investments: p.investments, digitalAssets: p.digitalAssets, debt: p.liabilities,
  });
  const est0 = new Map(ROWS.map((r) => [r.date, r.isEstimated === true]));
  const first = pt(before.history[0]), last = pt(before.history.at(-1)!);
  const raw = changeBlock(first, last) as Record<string, { abs: number } | unknown>;
  const rawNw = (raw.netWorth as { abs: number }).abs, rawDebt = (raw.debt as { abs: number }).abs;
  const tool = changeBlock(first, last, COV, est0) as Record<string, unknown>;
  assert.ok(!("netWorth" in tool) && !("debt" in tool), "withheld metrics carry no figure");
  assert.deepEqual(tool.unavailable, { netWorth: MESSAGE, debt: MESSAGE });
  assert.ok(String(tool.unavailableMeaning).includes(`history is partial before ${FLOOR}`));
  assert.deepEqual(tool.liquid, raw.liquid, "cash is covered since Jan 5 — its change is unchanged");
  assert.ok(carriesNone(JSON.stringify(tool), rawNw) && carriesNone(JSON.stringify(tool), rawDebt), "no cross-floor number in the tool result");
  assert.deepEqual(changeBlock(first, last, COV_COMPLETE, est0), raw, "complete window unchanged");
  const fromOct3 = pt(before.history.find((p) => p.date === "2026-10-03")!);
  const toolEst = changeBlock(fromOct3, last, COV_EST, est0) as Record<string, { estimated?: true }>;
  assert.equal(toolEst.debt.estimated, true, "estimated labelled");
  assert.equal(toolEst.liquid.estimated, undefined, "a cash change never carries the debt estimate");
  ok("§1c AI history tool change block: Jun 17 → Nov 3 withheld with reason, cash unchanged, complete unchanged, estimated labelled");
}

// ── §2 Space launcher card ───────────────────────────────────────────────────
{
  const raw: RawSnapshotRow[] = DAYS.map((d) => ({
    date: new Date(`${d.date}T00:00:00.000Z`), stocks: 0, crypto: 0, total: 0, cash: CASH, savings: 0, debt: d.debt,
    netWorth: CASH - d.debt, totalAssets: CASH, netLiquid: CASH - d.debt, cashOnHand: CASH, isEstimated: d.est,
  }));
  const points = admissibleNetWorthSeries(raw, "USD", null);
  assert.equal(points.length, DAYS.length, "every fixture row is admissible");
  const before = summarizeNetWorthSeries(points);
  assert.ok(before.change && Math.abs(before.change.abs) > 300_000, "pre-fix: the card's 1M change crosses the floor");

  const card = summarizeNetWorthSeries(points, COV);
  assert.equal(card.change, null, "withheld");
  assert.deepEqual(card.changeWithheld, { reason: "PARTIAL_BALANCE_HISTORY", coveredFrom: FLOOR, message: MESSAGE });
  assert.ok(carriesNone(JSON.stringify(card), before.change.abs) && !JSON.stringify(card).includes(String(before.change.pct)), "no cross-floor $ or %");
  assert.equal(card.netWorth, before.netWorth, "the figure itself is untouched");
  assert.deepEqual(card.trend, before.trend, "the sparkline (a shape, not a claim) is untouched");

  assert.deepEqual(summarizeNetWorthSeries(points, COV_COMPLETE), before, "complete window unchanged");
  assert.deepEqual(summarizeNetWorthSeries(points, null), before, "no coverage unchanged");
  const est = summarizeNetWorthSeries(points, COV_EST);
  assert.equal(est.change?.estimated, true, "estimated labelled");
  assert.equal(est.change?.pct, before.change.pct);

  // The card renders the reason, and the ≈ mark.
  const client = readFileSync(new URL("../../components/dashboard/SpacesClient.tsx", import.meta.url), "utf8");
  assert.ok(/delta === null && space\.changeWithheld &&/.test(client) && /title=\{space\.changeWithheld\.message\}/.test(client)
    && /sr-only">\{space\.changeWithheld\.message\}/.test(client), "card says why, never a %");
  assert.ok(/space\.change\?\.estimated \? "≈" : ""/.test(client), "estimated change marked ≈");
  ok("§2 launcher 1M change: withheld with reason, card renders it, complete unchanged, estimated ≈");
}

// ── §3 Daily Brief recentChanges ─────────────────────────────────────────────
const section3 = async () => {
  const inputs = (over: Partial<BriefInputs> = {}): BriefInputs => ({
    asOf: TODAY, today: TODAY, now: new Date(`${TODAY}T12:00:00.000Z`), currency: "USD",
    accounts: null, transactions: null, snapshot: projectSnapshotSection(ROWS, "full"), holdings: null,
    assessment: null, memories: [], recentActivity: null,
    snapshotEstimatedDates: ROWS.filter((r) => r.isEstimated).map((r) => r.date),
    ...over,
  });
  const before = projectBriefPackage(inputs()).recentChanges;
  assert.ok(before.m1?.debt && before.w1?.debt && before.m1.netWorth, "pre-fix: m1 / w1 measured across the floor");
  const m1Abs = before.m1.debt.abs, w1Abs = before.w1.debt!.abs;

  const rc = projectBriefPackage(inputs({ balanceCoverage: COV })).recentChanges;
  assert.ok(!rc.m1?.netWorth && !rc.m1?.debt && !rc.w1?.netWorth && !rc.w1?.debt, "netWorth / debt withheld on m1 and w1");
  assert.deepEqual(rc.m1?.unavailable, { netWorth: MESSAGE, debt: MESSAGE });
  assert.deepEqual(rc.w1?.unavailable, { netWorth: MESSAGE, debt: MESSAGE });
  assert.deepEqual(rc.m1?.liquid, before.m1.liquid, "liquid (covered) unchanged");
  assert.ok(carriesNone(JSON.stringify(rc), m1Abs) && carriesNone(JSON.stringify(rc), w1Abs), "no cross-floor number");
  // d1 = Nov 2 → Nov 3: on the floor, the Nov 2 reconstruction holds 4 debts flat.
  assert.equal(rc.d1?.debt?.estimated, true, "estimated labelled (held-flat endpoint)");
  assert.equal(rc.d1?.debt?.abs, before.d1?.debt?.abs, "…keeping its figure");
  assert.equal(rc.d1?.liquid?.estimated, undefined);

  assert.deepEqual(projectBriefPackage(inputs({ balanceCoverage: COV_COMPLETE })).recentChanges, before, "complete window unchanged");
  assert.deepEqual(projectBriefPackage(inputs({ balanceCoverage: null })).recentChanges, before, "no coverage unchanged");
  assert.ok(/listed under a window's unavailable was not measured, because history is partial before/.test(BRIEF_SYSTEM_PROMPT),
    "the Brief instruction says how to disclose it");

  // The loader: coverage read in its own phase, fed to the projection AND the package.
  const spaceCtx = {
    userId: "owner_A", spaceId: "space_A", role: "OWNER", permissions: {},
    space: { id: "space_A", name: "Household", type: "PERSONAL", category: "OTHER", isPublic: false, reportingCurrency: "USD" },
  } as unknown as SpaceContext;
  const deps = (balanceCoverage: () => Promise<BalanceCoverage | null>) => ({
    assemble: async () => null,
    readSnapshots: async () => ROWS,
    projectSnapshots: (r: Snapshot[], cov?: BalanceCoverage | null) => projectSnapshotSection(r, "full", cov ?? null),
    recall: async () => [],
    recentActivity: async (_s: string, asOf: string) => ({ from: asOf, to: asOf, days: 7, complete: true, transactionsInWindow: 0, top: [] }),
    assess: () => ({}) as FinancialAssessment,
    balanceCoverage,
  });
  const loaded = await loadBriefPackage({ spaceCtx, now: new Date(`${TODAY}T12:00:00.000Z`), deps: deps(async () => COV) });
  assert.deepEqual(loaded.package.recentChanges.m1?.unavailable, { netWorth: MESSAGE, debt: MESSAGE }, "loader gates the package");

  const warn = console.warn; const lines: string[] = [];
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  let failed;
  try {
    failed = await loadBriefPackage({ spaceCtx, now: new Date(`${TODAY}T12:00:00.000Z`),
      deps: deps(async () => { throw new Error("boom space_A acct_secret 316074.35"); }) });
  } finally { console.warn = warn; }
  const none = await loadBriefPackage({ spaceCtx, now: new Date(`${TODAY}T12:00:00.000Z`), deps: deps(async () => null) });
  assert.ok(none.package.recentChanges.m1?.debt, "no coverage ⇒ measured as before");
  // S2 sweep — FAIL CLOSED: every recent change is withheld with the unreadable reason, none measured.
  const windows = Object.values(failed.package.recentChanges);
  assert.ok(windows.length > 0 && windows.every((w) => w && !("debt" in w) && !("netWorth" in w)
    && Object.values(w.unavailable ?? {}).length > 0 && Object.values(w.unavailable ?? {}).every((m) => m === BALANCE_COVERAGE_UNREADABLE_MESSAGE)),
    "a failed coverage read withholds every recent change (fail closed), never measures across an unknown floor");
  assert.ok(!failed.degraded.includes("balanceCoverage"), "a failed coverage read never degrades the Brief");
  assert.deepEqual(lines, [balanceCoverageLoadFailureLine("daily-brief", 1, 1)], "one counts-only line");
  ok("§3 Daily Brief: m1/w1 netWorth+debt withheld with reason, d1 estimated labelled, complete unchanged, loader wired + fails CLOSED");
};

// ── §4 fail-CLOSED + counts-only log (S2 sweep; was fail-open) ───────────────
const section4 = async () => {
  assert.equal(balanceCoverageLoadFailureLine("ai-snapshot", 2, 5),
    "[balance-coverage] load failed surface=ai-snapshot failed=2 of=5; coverage unavailable, change claims withheld");
  const boom = { space: { findUnique: async () => { throw new Error("boom space_secret acct_42 $316,074.35"); } } } as never;
  const fine = { space: { findUnique: async () => ({ type: "PERSONAL" }) }, spaceAccountLink: { findMany: async () => [] } } as never;
  const warn = console.warn; const lines: string[] = [];
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    assert.equal(await loadBalanceCoverageFailClosed(boom, "space_secret", "ai-snapshot"), BALANCE_COVERAGE_UNAVAILABLE, "fails CLOSED to unavailable, never null");
    const by = await loadBalanceCoverageBySpace({
      space: { findUnique: async (q: { where: { id: string } }) => { if (q.where.id === "b") throw new Error("boom b"); return { type: "PERSONAL" }; } },
      spaceAccountLink: { findMany: async () => [] },
    } as never, ["a", "b"], "space-launcher");
    assert.deepEqual([...by.entries()], [["a", null], ["b", BALANCE_COVERAGE_UNAVAILABLE]], "nothing to cover stays null; the failed Space is unavailable");
    assert.equal(await loadBalanceCoverageFailClosed(fine, "x", "ai-snapshot"), null, "nothing to cover ⇒ null, no log");
  } finally { console.warn = warn; }
  assert.deepEqual(lines, [
    balanceCoverageLoadFailureLine("ai-snapshot", 1, 1),
    balanceCoverageLoadFailureLine("space-launcher", 1, 2),
  ]);
  assert.ok(lines.every((l) => !/space_secret|acct_|316|boom|\bb\b/.test(l.replace("surface=", ""))), "no ids, amounts or error text");
  // Null ("nothing to cover") gates nothing — as before.
  assert.deepEqual(gateWindowChange({ fromDate: "2026-06-17", toDate: TODAY }, null, ["liability"]),
    { change: { fromDate: "2026-06-17", toDate: TODAY }, withheld: null });
  // A FAILED read withholds every change coverage governs, with the unreadable reason…
  for (const sides of [["liability"], ["asset"], ["asset", "liability"]] as const) {
    assert.deepEqual(gateWindowChange({ fromDate: "2026-06-17", toDate: TODAY }, BALANCE_COVERAGE_UNAVAILABLE, sides),
      { change: null, withheld: { reason: "BALANCE_HISTORY_UNREADABLE", coveredFrom: null, message: BALANCE_COVERAGE_UNREADABLE_MESSAGE } });
  }
  // …and leaves a series of neither cash nor debt (investments, crypto) as it was: coverage never governed it.
  assert.deepEqual(gateWindowChange({ fromDate: "2026-06-17", toDate: TODAY }, BALANCE_COVERAGE_UNAVAILABLE, []),
    { change: { fromDate: "2026-06-17", toDate: TODAY }, withheld: null });
  ok("§4 coverage read failure: fails CLOSED (every change withheld), one counts-only line per surface (no ids / amounts / error text)");
};

// ── §5 wiring pins + the window-claims audit ─────────────────────────────────
{
  const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const asm = src("../ai/assemblers/snapshot.ts");
  assert.ok(/balanceCoverage = null \} = options/.test(asm)
    && /projectSnapshotSection\(rows, scopeHint === 'brief' \? 'brief' : 'full', balanceCoverage\)/.test(asm), "AI assembler takes coverage from options");
  assert.ok(!/loadBalanceCoverage/.test(strip(asm)), "…and NEVER reads it on its own (shared) client");
  const ev = src("../ai/conversation/evidence.ts");
  assert.ok(/read\('balance_coverage', \(c\) => loadBalanceCoverage\(c, spaceId\)\)\.catch\(/.test(ev) && /return BALANCE_COVERAGE_UNAVAILABLE;/.test(ev), "AI coverage read: its OWN prologue phase, fail-CLOSED");
  assert.ok(/const coverage = d === FinanceDomains\.SNAPSHOT_HISTORY \? await balanceCoverage : undefined;\n\s*const section = await read\(d,/.test(ev), "awaited outside the snapshot phase, then handed to it");
  assert.ok(/changeThisMonthUnavailable: snap\.canonicalChangeUnavailable\.message/.test(ev), "orientation carries the reason");
  const eng = src("../ai/conversation/engine.ts");
  assert.ok(/const balanceCoverage = readBalanceCoverage\(read, spaceCtx\.spaceId\);/.test(eng)
    && /assembleFullContext\(read, spaceCtx, agentId, balanceCoverage\)/.test(eng)
    && /balanceCoverage: \(\) => balanceCoverage,/.test(eng), "engine: one coverage read per transcript, shared with the tools");
  const tool = src("../ai/conversation/tools/history.ts");
  assert.ok(/if \(ctx\.balanceCoverage\) return ctx\.balanceCoverage\(\);/.test(tool)
    && /if \(!ctx\.phase\) return loadBalanceCoverageFailClosed\(ctx\.readClient, ctx\.spaceId, 'ai-history-tool'\);/.test(tool)
    && /return BALANCE_COVERAGE_UNAVAILABLE;/.test(tool)
    && (tool.match(/await historyCoverage\(ctx, rows\.length\)/g) ?? []).length === 2
    && /changeBlock\(pt\(inRange\[0\]\), pt\(inRange\[inRange\.length - 1\]\), balanceCoverage, estimatedOn\)/.test(tool),
    "history tool: coverage from the transcript's own phase; on its call client ONLY when there is no phase (no transaction)");
  const page = src("../../app/(shell)/dashboard/spaces/page.tsx");
  assert.ok(/loadBalanceCoverageBySpace\(tx, mySpaceIds, "space-launcher"\)/.test(page)
    && /getSpaceNetWorthSummaries\(tx, allIds, balanceCoverageBySpace\)/.test(page)
    && (page.match(/changeWithheld: nw\?\.changeWithheld \?\? null/g) ?? []).length === 2
    && /mySpaceIds\.map\(\(id\) => \[id, BALANCE_COVERAGE_UNAVAILABLE\] as const\)/.test(page), "launcher page wired; a failed phase fails CLOSED");
  const snaps = src("../data/snapshots.ts");
  assert.ok(/summarizeNetWorthSeries\(\s*admissibleNetWorthSeries\(series, target, stampCtx\), balanceCoverage\?\.get\(id\) \?\? null\)/.test(snaps), "summaries gated per Space");
  const load = src("../ai/brief/load.ts");
  assert.ok(/loadBalanceCoverageFailClosed\(c, spaceId, 'daily-brief'\)/.test(load) && /return BALANCE_COVERAGE_UNAVAILABLE;/.test(load) && /deps\.projectSnapshots\(ceiled, balanceCoverage\)/.test(load)
    && /\n    balanceCoverage,\n    snapshotEstimatedDates:/.test(load), "Brief loader wired");
  const pes = src("../../components/space/PerspectiveEmptyState.tsx");
  assert.equal((pes.match(/coverageReadFailed\(\)/g) ?? []).length, 4, "client hero path: counts-only line on !ok, on a thrown fetch and on an unavailable / malformed coverage");
  assert.ok(/balanceCoverageLoadFailureLine\("client-data-health", 1, 1\)/.test(pes));

  // No second definition of the rule: every server path goes through the core.
  for (const f of [asm, tool, src("../data/snapshot-summary.core.ts"), src("../ai/brief/package.ts")]) {
    assert.ok(/gateWindowChange|changeComparability/.test(f) && !/coveredFromISO\s*[<>]/.test(f), "one rule, from balance-coverage.core");
  }
  // audit-snapshot-window-claims: still asserts the canonical authority, and now
  // also that the gate only ever withholds (null + reason), never alters a figure.
  const audit = src("../../scripts/audit-snapshot-window-claims.ts");
  assert.ok(/canonicalWindowChange\(points, "PAST_MONTH"\)/.test(audit) && /gateWindowChange\(change, null/.test(audit)
    && /PARTIAL_BALANCE_HISTORY/.test(audit), "the audit understands withheld changes");
  assert.ok(!/import\s+["']server-only["']|from\s+["']@\/lib\/connections\/balance-coverage["']/.test(audit)
    && /from "@\/lib\/connections\/balance-coverage\.core"/.test(audit), "the audit imports only the pure core (plain tsx)");
  // The audit's new invariant, on this fixture's real window.
  const nw = projectSnapshotSection(ROWS, "full")!.canonicalChange!;
  assert.deepEqual(gateWindowChange(nw, null, ["asset", "liability"]).change, nw);
  assert.equal(gateWindowChange(nw, COV, ["asset", "liability"]).withheld?.message, changeUnavailableMessage(FLOOR));
  ok("§5 every server path wired through the one rule; window-claims audit extended (not weakened)");
}

// ── §6 the coverage read never shares a transaction with the AI assembly ─────
const section6 = async () => {
  // A fake tenant phase per read, faithful to Postgres: once a statement fails
  // inside a transaction, every later statement in it fails too.
  const parts: string[] = [];
  const rawRows = DAYS.map((d) => ({
    date: new Date(`${d.date}T00:00:00.000Z`), reportingCurrency: "USD", stocks: 0, crypto: 0, total: 0,
    cash: CASH, savings: 0, debt: d.debt, netWorth: CASH - d.debt, totalAssets: CASH, netLiquid: CASH - d.debt,
    cashOnHand: CASH, isEstimated: d.est, cryptoValuationStatus: null, completenessTier: null,
    contributingComponentCount: null, totalComponentCount: null,
  }));
  const phaseClient = (part: string, coverageThrows: boolean) => {
    let aborted = false;
    const q = <T>(f: () => T) => async () => {
      if (aborted) throw new Error("current transaction is aborted, commands ignored until end of transaction block");
      try { return f(); } catch (e) { aborted = true; throw e; }
    };
    const any = new Proxy({}, { get: () => q(() => []) });
    return new Proxy({
      spaceSnapshot: { findMany: q(() => rawRows) },
      space: { findUnique: q(() => { if (coverageThrows && part === "balance_coverage") throw new Error("boom space_A"); return { reportingCurrency: "USD", type: "PERSONAL" }; }) },
      spaceAccountLink: { findMany: q(() => []) },
    } as Record<string, unknown>, { get: (t, k: string) => t[k] ?? any });
  };
  const runner = (coverageThrows: boolean) => (<T>(part: string, fn: (c: never) => Promise<T>) => {
    parts.push(part);
    return fn(phaseClient(part, coverageThrows) as never);
  });
  const spaceCtx = {
    userId: "owner_A", spaceId: "space_A", role: "OWNER", permissions: {},
    space: { id: "space_A", name: "Household", type: "PERSONAL", category: "OTHER", isPublic: false, reportingCurrency: "USD" },
  } as unknown as SpaceContext;
  const { assembleFullContext, readBalanceCoverage } = await import("@/lib/ai/conversation/evidence");

  const warn = console.warn; const lines: string[] = [];
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  let ctx; let cov;
  try {
    cov = await readBalanceCoverage(runner(true), "space_A");
    ctx = await assembleFullContext(runner(true), spaceCtx, "t");
  } finally { console.warn = warn; }
  assert.equal(cov, BALANCE_COVERAGE_UNAVAILABLE, "a throwing coverage read fails CLOSED to unavailable (never rejects, never null)");
  const snapData = ctx.domains[FinanceDomains.SNAPSHOT_HISTORY]?.data as ReturnType<typeof projectSnapshotSection>;
  assert.ok(snapData, "the turn still assembles its snapshot domain");
  assert.ok(!ctx.unreadableDomains?.includes(FinanceDomains.SNAPSHOT_HISTORY), "the snapshot domain is not unreadable");
  assert.ok(!ctx.unreadableDomains?.includes("balance_coverage"), "a coverage failure is never named as an unreadable domain");
  const ungated = projectSnapshotSection(ROWS, "full")!.canonicalChange;
  assert.ok(ungated && snapData!.canonicalChange === null
    && snapData!.canonicalChangeUnavailable?.reason === "BALANCE_HISTORY_UNREADABLE"
    && snapData!.balanceHistoryCompleteness?.state === "UNAVAILABLE",
    "the change is WITHHELD with the unreadable reason, and the section says why (fail closed)");
  assert.ok(lines.length >= 2 && lines.every((l) => l === balanceCoverageLoadFailureLine("ai-snapshot", 1, 1)),
    `the counts-only line fires: ${JSON.stringify(lines)}`);
  assert.ok(parts.includes("balance_coverage") && parts.includes(FinanceDomains.SNAPSHOT_HISTORY), "coverage read in its OWN phase");

  // And with coverage readable in that phase, the same assembly withholds.
  const covering = <T>(part: string, fn: (c: never) => Promise<T>) => part === "balance_coverage"
    ? Promise.resolve(COV as unknown as T)
    : runner(false)(part, fn);
  const gatedCtx = await assembleFullContext(covering, spaceCtx, "t");
  const g = gatedCtx.domains[FinanceDomains.SNAPSHOT_HISTORY]?.data as ReturnType<typeof projectSnapshotSection>;
  assert.equal(g?.canonicalChange, null);
  assert.equal(g?.canonicalChangeUnavailable?.message, MESSAGE, "the assembled context carries the reason");
  ok("§6 AI assembly: a throwing coverage read (own phase) leaves the turn assembled, the change WITHHELD (fail closed), the log line fired");
};

section3().then(section4).then(section6).then(() => {
  for (const c of checks) console.log("  ✓ " + c);
  console.log(`server-change-claims: ${checks.length} checks passed`);
}).catch((e) => { console.error(e); process.exit(1); });
