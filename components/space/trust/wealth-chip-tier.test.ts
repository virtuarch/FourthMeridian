/**
 * components/space/trust/wealth-chip-tier.test.ts
 *
 * v2.7 final UX pass (owner-authorized §6) — the Net Worth / Assets hero chip
 * states the as-of snapshot's RESOLVED completenessTier, mapped presentation-
 * side, while every AI / Daily Brief input stays byte-for-byte unchanged.
 *
 *   (a) mapping per tier, incl. the missing-tier fallback and slice scoping;
 *   (b) isolation pins — WealthResult (incl. .completeness) is identical with
 *       or without the tier on the rows; the envelope without the new input is
 *       identical to before; no AI / Brief module imports any of this;
 *   (c) Net Worth / Assets / Debt / Cash on the SAME past date: every chip
 *       describes the figure beside it.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/trust/wealth-chip-tier.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { CompletenessTier, LensResult } from "@/lib/perspective-engine/types";
import type { Snapshot } from "@/types";
import { computeWealthTimeMachine } from "@/lib/wealth/wealth-time-machine";
import { resolvePerspectiveEnvelope, COMPLETENESS_PRESENTATION } from "@/lib/perspectives/envelope";
import { wealthChipTier, asOfSnapshotTier } from "./wealth-chip-tier";
import { presentFigureEnvelope } from "./figure-envelope";
import { TrustIndicator } from "./TrustIndicator";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const chip = (env: ReturnType<typeof resolvePerspectiveEnvelope>) =>
  text(renderToStaticMarkup(createElement(TrustIndicator, { envelope: env, variant: "compact" })));

const snap = (date: string, o: { isEstimated?: boolean; tier?: CompletenessTier } = {}): Snapshot => ({
  date, totalCash: 100, totalSavings: 0, totalInvestments: 50, totalCrypto: 0, totalDebt: 0, totalAssets: 150, netWorth: 150, cashOnHand: 100,
  ...(o.isEstimated ? { isEstimated: true } : {}),
  ...(o.tier ? { completenessTier: o.tier, completenessRecorded: true } : {}),
});
const run = (rows: Snapshot[], asOf: string) => computeWealthTimeMachine({ snapshots: rows, asOf, compareTo: null, currency: "USD" });
function chipFor(rows: Snapshot[], asOf: string, metric = "netWorth") {
  const r = run(rows, asOf);
  const t = wealthChipTier({ found: r.asOfState.found, isEstimated: r.asOfState.isEstimated, completenessTier: asOfSnapshotTier(rows, r.asOfState.date), metric });
  return { r, t, env: resolvePerspectiveEnvelope({ perspectiveId: "wealth", wealthResult: r, currency: "USD", wealthChipTier: t }) };
}

console.log("(a) chip mapping per resolved tier");
{
  const cases: [string, Snapshot, string][] = [
    ["observed ⇒ nothing", snap("2026-09-30", { tier: "observed" }), ""],
    ["derived ⇒ Reconstructed", snap("2026-09-30", { isEstimated: true, tier: "derived" }), "Reconstructed"],
    ["estimated ⇒ Estimated (was 'Reconstructed')", snap("2026-09-30", { isEstimated: true, tier: "estimated" }), "Estimated"],
    ["incomplete (reconstructed partial) ⇒ Incomplete", snap("2026-09-30", { isEstimated: true, tier: "incomplete" }), "Incomplete"],
    ["incomplete RECORDED on an observed row (FX excluded) ⇒ Incomplete (was silent)", snap("2026-09-30", { tier: "incomplete" }), "Incomplete"],
    ["no tier + isEstimated ⇒ fallback Reconstructed", snap("2026-09-30", { isEstimated: true }), "Reconstructed"],
    ["no tier + observed ⇒ fallback nothing", snap("2026-09-30"), ""],
  ];
  for (const [name, row, want] of cases) {
    const got = chip(chipFor([row], "2026-09-30").env);
    check(name, want === "" ? got === "" : got.includes(want) && !(want === "Reconstructed" && got.includes("Estimated")), got);
  }
  check("no snapshot on/before the date ⇒ the read model's 'No history' wording (unchanged)",
    chipFor([snap("2026-09-30", { tier: "estimated" })], "2026-01-01").env.completeness?.label.startsWith("No history") === true);
  const est = chipFor([snap("2026-09-30", { isEstimated: true, tier: "estimated" })], "2026-09-30").env.completeness!;
  check("labels/tones come from the canonical COMPLETENESS_PRESENTATION", est.label === COMPLETENESS_PRESENTATION.estimated.label && est.tone === COMPLETENESS_PRESENTATION.estimated.tone);
  check("tooltip names the snapshot date", /Sep 30, 2026|30 Sep 2026|2026-09-30/.test(est.detail ?? ""), est.detail);
  // Slices: the row tier is the WORST of every component, so it speaks only for whole-row aggregates.
  for (const m of ["cash", "invested", "liquidNetWorth", "totalLiabilities"]) {
    check(`slice '${m}' keeps the legacy rule (no row-tier leak)`,
      wealthChipTier({ found: true, isEstimated: false, completenessTier: "estimated", metric: m }) === "observed");
  }
  check("Total assets uses the row tier", wealthChipTier({ found: true, isEstimated: true, completenessTier: "estimated", metric: "totalAssets" }) === "estimated");
  check("asOfSnapshotTier picks the row for the as-of date", asOfSnapshotTier([snap("2026-09-29", { tier: "derived" }), snap("2026-09-30", { tier: "estimated" })], "2026-09-30") === "estimated");
}

console.log("\n(b) isolation — AI / Brief-facing values unchanged");
{
  const plain = [snap("2026-09-29", { isEstimated: true }), snap("2026-09-30", { isEstimated: true }), snap("2026-10-27")];
  const tiered = [snap("2026-09-29", { isEstimated: true, tier: "derived" }), snap("2026-09-30", { isEstimated: true, tier: "estimated" }), snap("2026-10-27", { tier: "incomplete" })];
  for (const asOf of ["2026-09-30", "2026-10-27"]) {
    const a = run(plain, asOf), b = run(tiered, asOf);
    check(`${asOf}: WealthResult.completeness identical with/without resolved tiers`, JSON.stringify(a.completeness) === JSON.stringify(b.completeness), `${JSON.stringify(a.completeness)} vs ${JSON.stringify(b.completeness)}`);
    check(`${asOf}: the whole WealthResult is identical (series, chart dashing, deltas)`, JSON.stringify(a) === JSON.stringify(b));
  }
  check("WealthResult.completeness keeps the legacy rule (estimated row ⇒ derived)", run(tiered, "2026-09-30").completeness.tier === "derived");
  const r = run(tiered, "2026-09-30");
  check("envelope WITHOUT the new input is the legacy envelope (Reconstructed)", resolvePerspectiveEnvelope({ perspectiveId: "wealth", wealthResult: r, currency: "USD" }).completeness?.tier === "derived");
  // No AI / Brief / snapshot-writer module can see the presentation mapping or the wealth envelope.
  const ROOT = process.cwd();
  const walk = (dir: string): string[] => readdirSync(path.join(ROOT, dir)).flatMap((f) => {
    const rel = `${dir}/${f}`;
    return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [rel] : [];
  });
  const files = [...walk("lib/ai"), ...walk("lib/snapshots"), "lib/brief-types.ts"];
  const leaks = files.filter((f) => /wealth-chip-tier|figure-envelope|perspectives\/envelope|wealth\/wealth-time-machine/.test(readFileSync(path.join(ROOT, f), "utf8")));
  check(`no lib/ai (incl. brief) / lib/snapshots module imports the chip mapping, the envelope or the wealth read model (${files.length} files)`, leaks.length === 0, leaks.join(", "));
}

console.log("\n(c) Net Worth / Assets / Debt / Cash on the SAME past date");
{
  const PAST = "2026-09-30";
  const rows = [snap(PAST, { isEstimated: true, tier: "estimated" }), snap("2026-10-27")];
  const nw = chip(chipFor(rows, PAST, "netWorth").env);
  const assets = chip(chipFor(rows, PAST, "totalAssets").env);
  const cashSlice = chip(chipFor(rows, PAST, "cash").env);
  check("Net Worth (as-of snapshot figure) ⇒ Estimated — the row's resolved tier", nw.includes("Estimated"), nw);
  check("Assets (same whole-row snapshot) ⇒ Estimated — same basis, same chip", assets === nw, assets);
  check("Assets → Cash slice (snapshot, legacy rule) ⇒ Reconstructed — never the row's crypto/investment tier", cashSlice.includes("Reconstructed") && !cashSlice.includes("Estimated"), cashSlice);
  const lens = (tier?: CompletenessTier, lensId: "debt" | "liquidity" = "debt") => ({
    lensId, lensVersion: 1, scope: { spaceId: "s", userId: "u" }, computedAt: "2026-10-27T08:00:00.000Z", status: "ok", metrics: [],
    provenance: { accountIds: ["a"], dataAsOf: "2026-10-27T07:00:00.000Z", dataAsOfBasis: "CHECKED" },
    ...(tier ? { completeness: { tier, conflict: false, reason: "as-of reconstruction" } } : {}),
  } as unknown as LensResult);
  for (const id of ["debt", "liquidity"] as const) {
    const onScreen = resolvePerspectiveEnvelope({ perspectiveId: id, lensResult: lens("estimated", id) });
    const hero = chip(presentFigureEnvelope({ perspectiveId: id, historical: true, presentLens: lens(undefined, id), onScreen }));
    check(`${id === "debt" ? "Debt" : "Cash"} (present-day figure) ⇒ no as-of chip on the same date`, hero === "", hero);
  }
}

if (failures > 0) { console.error(`\nwealth-chip-tier: ${failures} failure(s).`); process.exit(1); }
console.log("\nwealth-chip-tier: all passed.");
