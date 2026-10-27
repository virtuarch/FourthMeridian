/**
 * components/space/trust/estimated-badge-confidence.test.ts
 *
 * v2.7 final UX pass — "Estimated badge confidence". The hero trust chip must
 * describe the FIGURE BESIDE IT, on its real basis and date:
 *
 *   1. Debt / Cash heroes state PRESENT-DAY figures in every view, so in a past
 *      As-Of their chip reads the present lens — the as-of reconstruction tier
 *      ("Estimated": loans held flat, cards walked back) no longer sits beside a
 *      figure that was never reconstructed.
 *   2. The chip no longer depends on the as-of fetch lifecycle: a data refresh
 *      re-keys the as-of lens (briefly null), which used to make it vanish.
 *   3. Net Worth / Assets state the AS-OF snapshot figure, so their chip follows
 *      that snapshot's own basis (Reconstructed vs silent-observed) and its
 *      tooltip names the snapshot date. A refresh writing a fresh observed
 *      snapshot TODAY never relabels a reconstructed PAST date as observed.
 *   4. Placement: every hero puts the chip in the shared fixed-height
 *      HeroEyebrow row.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/trust/estimated-badge-confidence.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { LensResult, CompletenessTier } from "@/lib/perspective-engine/types";
import type { Snapshot } from "@/types";
import { resolvePerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { computeWealthTimeMachine } from "@/lib/wealth/wealth-time-machine";
import { presentFigureEnvelope } from "./figure-envelope";
import { TrustIndicator } from "./TrustIndicator";
import { DebtHero } from "@/components/space/widgets/debt/DebtHero";
import { computeDebtKpis } from "@/components/space/widgets/debt/debt-kpis";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const chip = (env: ReturnType<typeof resolvePerspectiveEnvelope>) =>
  text(renderToStaticMarkup(createElement(TrustIndicator, { envelope: env, variant: "compact" })));

function lens(o: { lensId?: "debt" | "liquidity"; tier?: CompletenessTier; computedAt?: string; estimated?: boolean } = {}): LensResult {
  return {
    lensId: o.lensId ?? "debt", lensVersion: 1, scope: { spaceId: "s", userId: "u" },
    computedAt: o.computedAt ?? "2026-10-27T08:00:00.000Z", status: "ok",
    metrics: [],
    provenance: { accountIds: ["a1", "a2"], dataAsOf: "2026-10-27T07:00:00.000Z", dataAsOfBasis: "CHECKED" },
    ...(o.estimated ? { estimated: true } : {}),
    ...(o.tier ? { completeness: { tier: o.tier, conflict: false, reason: `Revolving-card balances are reconstructed as of 2026-09-30; installment loans are held at their current balance.` } } : {}),
  } as unknown as LensResult;
}

const PRESENT = lens();                                  // a present-day read: no completeness ⇒ observed
const AS_OF   = lens({ tier: "estimated" });             // the past-date reconstruction

console.log("1. the as-of reconstruction tier is real — and is what used to leak into the hero");
{
  const onScreen = resolvePerspectiveEnvelope({ perspectiveId: "debt", lensResult: AS_OF });
  check("as-of debt lens resolves 'Estimated' (tier semantics unchanged)", onScreen.completeness?.tier === "estimated" && chip(onScreen).includes("Estimated"));
  check("present-day debt lens resolves observed ⇒ the compact chip is silent",
    resolvePerspectiveEnvelope({ perspectiveId: "debt", lensResult: PRESENT }).completeness?.tier === "observed"
      && chip(resolvePerspectiveEnvelope({ perspectiveId: "debt", lensResult: PRESENT })) === "");
}

console.log("\n2. Debt / Cash hero: the chip follows the PRESENT-DAY headline's basis");
for (const perspectiveId of ["debt", "liquidity"] as const) {
  const onScreen = resolvePerspectiveEnvelope({ perspectiveId, lensResult: lens({ lensId: perspectiveId, tier: "estimated" }) });
  const past = presentFigureEnvelope({ perspectiveId, historical: true, presentLens: lens({ lensId: perspectiveId }), onScreen });
  check(`${perspectiveId}: past As-Of ⇒ no 'Estimated' beside the present-day figure`, chip(past) === "", chip(past));
  const today = presentFigureEnvelope({ perspectiveId, historical: false, presentLens: lens({ lensId: perspectiveId }), onScreen });
  check(`${perspectiveId}: present day ⇒ exactly the on-screen envelope (same object)`, today === onScreen);
  // An orthogonal caveat on the PRESENT figure still shows — the fix hides nothing real.
  const fx = presentFigureEnvelope({ perspectiveId, historical: true, presentLens: lens({ lensId: perspectiveId, estimated: true }), onScreen });
  check(`${perspectiveId}: an FX caveat on the present-day figure still surfaces`, chip(fx).includes("Some FX rates estimated"), chip(fx));
}

console.log("\n3. refresh-stable: the hero chip no longer rides the as-of fetch lifecycle");
{
  // Before: a refresh bumps presentLens.computedAt ⇒ the as-of cache key changes ⇒
  // the as-of lens is null until the refetch lands ⇒ the on-screen envelope is {}.
  const duringRefetch = resolvePerspectiveEnvelope({ perspectiveId: "debt", lensResult: null });
  const before = presentFigureEnvelope({ perspectiveId: "debt", historical: true, presentLens: PRESENT, onScreen: resolvePerspectiveEnvelope({ perspectiveId: "debt", lensResult: AS_OF }) });
  const mid    = presentFigureEnvelope({ perspectiveId: "debt", historical: true, presentLens: lens({ computedAt: "2026-10-27T09:00:00.000Z" }), onScreen: duringRefetch });
  check("on-screen envelope is empty mid-refetch (the old vanishing point)", duringRefetch.completeness === undefined);
  check("hero envelope is the same tier before and during the refetch", before.completeness?.tier === "observed" && mid.completeness?.tier === "observed");
  check("…and the rendered chip is identical (no flicker, no relabel)", chip(before) === chip(mid));
}

console.log("\n4. DebtHero in a past As-Of renders no 'Estimated' beside the present-day total");
{
  const kpis = computeDebtKpis([{ id: "l1", name: "Loan", type: "debt", institution: "Bank", balance: -1000, currency: "USD" } as never]);
  const props = {
    kpis, currency: "USD", liabilityCount: 1, asOf: "2026-09-30", today: "2026-10-27", historical: true, change: null,
    verdict: null, verdictAsOf: null, redactions: 0,
  };
  const onScreen = resolvePerspectiveEnvelope({ perspectiveId: "debt", lensResult: AS_OF });
  const html = renderToStaticMarkup(createElement(DebtHero, { ...props, envelope: presentFigureEnvelope({ perspectiveId: "debt", historical: true, presentLens: PRESENT, onScreen }) }));
  check("no Estimated chip; the 'current balances' basis is stated instead", !text(html).includes("Estimated") && /current balances/i.test(text(html)));
}

console.log("\n5. Net Worth / Assets: the chip follows the as-of SNAPSHOT's basis + date");
{
  const snap = (date: string, isEstimated: boolean): Snapshot => ({
    date, totalCash: 100, totalSavings: 0, totalInvestments: 0, totalCrypto: 0, totalDebt: 0, totalAssets: 100, netWorth: 100, cashOnHand: 100,
    ...(isEstimated ? { isEstimated: true } : {}),
  });
  const past = [snap("2026-09-29", true), snap("2026-09-30", true)];
  const r1 = computeWealthTimeMachine({ snapshots: past, asOf: "2026-09-30", compareTo: null, currency: "USD" });
  const e1 = resolvePerspectiveEnvelope({ perspectiveId: "wealth", wealthResult: r1, currency: "USD" });
  check("a reconstructed as-of snapshot ⇒ 'Reconstructed' chip", chip(e1).includes("Reconstructed"));
  check("its tooltip names the snapshot date it comes from", /Sep 30, 2026|2026-09-30|30 Sep 2026/.test(e1.completeness?.detail ?? ""), e1.completeness?.detail);
  // A refresh writes an OBSERVED snapshot for today — the past date is untouched.
  const r2 = computeWealthTimeMachine({ snapshots: [...past, snap("2026-10-27", false)], asOf: "2026-09-30", compareTo: null, currency: "USD" });
  check("a fresh observed snapshot today never relabels the past date as observed",
    resolvePerspectiveEnvelope({ perspectiveId: "wealth", wealthResult: r2, currency: "USD" }).completeness?.tier === "derived");
  const r3 = computeWealthTimeMachine({ snapshots: [...past, snap("2026-10-27", false)], asOf: "2026-10-27", compareTo: null, currency: "USD" });
  check("today's observed snapshot ⇒ the chip is silent (observed, on its own date)",
    chip(resolvePerspectiveEnvelope({ perspectiveId: "wealth", wealthResult: r3, currency: "USD" })) === "");
}

console.log("\n6. one placement: every hero's chip sits in the shared HeroEyebrow row");
for (const f of [
  "components/space/widgets/wealth/WealthHero.tsx",
  "components/space/widgets/debt/DebtHero.tsx",
  "components/space/widgets/liquidity/LiquidityHero.tsx",
  "components/space/widgets/investments/InvestmentsHero.tsx",
]) {
  const src = readFileSync(path.join(process.cwd(), f), "utf8");
  check(`${f.split("/").pop()} — <HeroEyebrow … trust={<TrustIndicator variant="compact" …/>}`,
    /<HeroEyebrow label=[^>]*trust=\{<TrustIndicator variant="compact" envelope=\{envelope\} \/>\}/.test(src)
      || (/<HeroEyebrow label=[^>]*trust=\{confidenceChip\}/.test(src) && /const confidenceChip = <TrustIndicator variant="compact" envelope=\{envelope\} \/>;/.test(src)));
}

if (failures > 0) { console.error(`\nestimated-badge-confidence: ${failures} failure(s).`); process.exit(1); }
console.log("\nestimated-badge-confidence: all passed.");
