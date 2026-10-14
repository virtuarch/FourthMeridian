/**
 * lib/freshness/estimate-horizon.test.ts   (RWA-1B)
 *
 * A manual asset's value is the USER'S ESTIMATE, not a feed observation. It is
 * judged on the estimate horizon (stale at 180 days, very stale at 365), it does
 * not set the Space header's "Last checked" anchor while any fed account is
 * observed, and every reader that calls a manual source stale — the Space
 * header, Connections/Brief source health, the AI accounts summary — uses the
 * same cut.
 *
 *   npx tsx lib/freshness/estimate-horizon.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ESTIMATE_STALE_AFTER_DAYS, ESTIMATE_VERY_STALE_AFTER_DAYS, STALE_AFTER_DAYS,
  bandForEstimateAge, resolveAccountFreshness,
} from "./observation";
import { resolveSpaceFreshness } from "./space-freshness";
import { deriveSourceHealth } from "@/lib/connections/space-data-health.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const now = new Date("2026-10-15T12:00:00Z");
const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
const code = (...p: string[]) =>
  readFileSync(join(process.cwd(), ...p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("the horizon");
check("estimate horizon is longer than the feed horizon", ESTIMATE_STALE_AFTER_DAYS > STALE_AFTER_DAYS);
check("180 / 365", ESTIMATE_STALE_AFTER_DAYS === 180 && ESTIMATE_VERY_STALE_AFTER_DAYS === 365);
check("bands", bandForEstimateAge(0.5) === "LIVE" && bandForEstimateAge(20) === "RECENT" &&
  bandForEstimateAge(200) === "STALE" && bandForEstimateAge(400) === "VERY_STALE" && bandForEstimateAge(null) === "UNKNOWN");

console.log("resolveAccountFreshness — the clock is unchanged, only the band");
const est20 = resolveAccountFreshness({ accountId: "h", ingestedAt: ago(20), balance: 500_000, userEstimate: true }, now);
const feed20 = resolveAccountFreshness({ accountId: "b", ingestedAt: ago(20), balance: 500_000 }, now);
check("a 20-day-old estimate is RECENT", est20.balance.band === "RECENT", est20.balance.band);
check("…the same age on a feed is STALE (feed rule untouched)", feed20.balance.band === "STALE", feed20.balance.band);
check("basis stays INGESTION (we know when it was written, nothing more)", est20.balance.basis === "INGESTION");
check("the estimate carries userEstimate", est20.userEstimate === true);
check("a feed row's payload shape is unchanged (no userEstimate key)", !("userEstimate" in feed20));
check("userEstimate:false is the feed rule", resolveAccountFreshness({ accountId: "x", ingestedAt: ago(20), userEstimate: false }, now).balance.band === "STALE");

console.log("resolveSpaceFreshness — estimates never set the feed anchor");
const bankFresh = { accountId: "bank", ingestedAt: ago(0.1), balance: 10_000 };
const house90   = { accountId: "house", ingestedAt: ago(90), balance: 500_000, userEstimate: true };
const s1 = resolveSpaceFreshness([bankFresh, house90], now);
check("anchor is the bank, not the 90-day-old estimate", s1.anchor.accountId === "bank", String(s1.anchor.accountId));
check("no stale accounts, no unverified value", s1.staleAccountCount === 0 && (s1.staleValueShare ?? 0) === 0);
check("claim UNIFORM, no qualifier", s1.claim === "UNIFORM" && s1.qualifier === null, `${s1.claim} ${s1.qualifier}`);
check("estimateCount = 1", s1.estimateCount === 1);

const house200 = { ...house90, ingestedAt: ago(200) };
const s2 = resolveSpaceFreshness([bankFresh, house200], now);
check("a 200-day-old estimate IS stale and its value unverified", s2.claim === "STALE" && s2.staleAccountCount === 1 && (s2.staleValueShare ?? 0) > 0.9);
check("…but the anchor still describes the fed account", s2.anchor.accountId === "bank");

const s3 = resolveSpaceFreshness([house90, { accountId: "car", ingestedAt: ago(10), balance: 20_000, userEstimate: true }], now);
check("a Space holding ONLY estimates anchors on its oldest estimate", s3.anchor.accountId === "house", String(s3.anchor.accountId));
check("…and is not stale at 90 days", s3.staleAccountCount === 0);

const legacy = resolveSpaceFreshness([bankFresh, { accountId: "house", ingestedAt: ago(90), balance: 500_000 }], now);
check("without the flag the old behaviour stands (anchor = 90-day row, STALE)", legacy.anchor.accountId === "house" && legacy.claim === "STALE");

console.log("deriveSourceHealth — Connections/Brief manual source, same horizon");
const manual = (days: number) => deriveSourceHealth({ kind: "MANUAL", accountsUpdated: [ago(days)] }, now).state;
check("manual source at 100 days is CURRENT (was OUT_OF_DATE at 30)", manual(100) === "CURRENT", manual(100));
check("manual source at 200 days is OUT_OF_DATE", manual(200) === "OUT_OF_DATE", manual(200));

console.log("every reader is wired to the estimate horizon");
const MOUNT = code("lib", "space", "mount-composition.ts");
check("Space accounts flag estimates by syncStatus, never on an aggregate row",
  MOUNT.includes('l.financialAccount.syncStatus === "manual"') && MOUNT.includes("!a.aggregate && estimateIds.has(a.id)"));
const DASH = code("components", "dashboard", "SpaceDashboard.tsx");
check("the Space header passes the flag", DASH.includes("userEstimate:       a.userEstimate === true"));
const CARD = code("lib", "freshness", "space-card-freshness.ts");
check("the Spaces-list card passes the flag", CARD.includes('userEstimate:      r.financialAccount.syncStatus === "manual"'));
const DETAIL = code("app", "api", "spaces", "[id]", "accounts", "detail", "route.ts");
check("the accounts detail read passes the flag", DETAIL.includes('userEstimate:      a.syncStatus === "manual"'));
const AI = code("lib", "ai", "assemblers", "accounts.ts");
check("AI: manual rows carry valuationSource USER_ESTIMATE",
  AI.includes("fa.syncStatus === 'manual' ? { valuationSource: 'USER_ESTIMATE' as const } : {}"));
check("AI: the stale-manual count uses the estimate horizon (no 30-day literal)",
  AI.includes("daysSince >= ESTIMATE_STALE_AFTER_DAYS") && !/daysSince > 30\b/.test(AI));
const DET = code("lib", "ai", "signals", "detectors", "accounts.ts");
check("AI signal title states the horizon it uses", DET.includes("${ESTIMATE_STALE_AFTER_DAYS}+ days") && !DET.includes("30+ days"));

if (failures > 0) {
  console.error(`\nestimate-horizon: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nestimate-horizon: all passed.");
