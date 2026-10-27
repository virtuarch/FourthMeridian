/**
 * lib/space/perspective-empty-state.test.ts  (Connections pass PR 4)
 *
 * One empty-state answer for every Personal perspective — never replacing a
 * genuine zero or real content, never inventing a reason.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { classifyPerspectiveEmpty, EMPTY_COPY, sourceFeeds, type PerspectiveKey } from "@/lib/space/perspective-empty-state.core";
import type { DataSourceView } from "@/lib/connections/space-data-health.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const src = (over: Partial<DataSourceView>): DataSourceView => ({
  kind: "BANK", label: "Chase", state: "CURRENT", lastUpdatedAt: "2026-10-28T00:00:00Z",
  accountCount: 1, needsAttention: false, actionable: true, feeds: ["liquid", "bankingRows"], ...over,
} as DataSourceView);

const bank = src({});
const card = src({ label: "Amex", feeds: ["liabilities", "bankingRows"] });
const wallet = src({ kind: "WALLET", label: "BTC", feeds: ["digitalAssets"] });
const house = src({ kind: "MANUAL", label: "Home", feeds: ["realAssets"] });
const ALL: PerspectiveKey[] = ["netWorth", "assets", "debt", "cash", "investments", "cashFlow", "spending"];

console.log("never replaces content");
{
  for (const p of ALL) check(`${p}: content wins (reason null)`, classifyPerspectiveEmpty(p, [bank, card, wallet, house], true).reason === null);
  check("content + a failed feeding source ⇒ a NOTE, not a replacement",
    JSON.stringify(classifyPerspectiveEmpty("cash", [src({ state: "NEEDS_RECONNECT" })], true).note) === '"FAILED"');
  check("content + a stale source ⇒ STALE note", classifyPerspectiveEmpty("cash", [src({ state: "OUT_OF_DATE" })], true).note === "STALE");
}

console.log("genuine zero stays a zero");
{
  check("Debt with a current card and no rows ⇒ null (\"No debt\" is a fact)", classifyPerspectiveEmpty("debt", [card], false).reason === null);
  check("Spending with a current bank and nothing spent ⇒ null", classifyPerspectiveEmpty("spending", [bank], false).reason === null);
}

console.log("why it is empty");
{
  for (const p of ALL) check(`${p}: no sources ⇒ NO_SOURCES`, classifyPerspectiveEmpty(p, [], false).reason === "NO_SOURCES");
  check("Debt with only a wallet ⇒ NOT_FED", classifyPerspectiveEmpty("debt", [wallet], false).reason === "NOT_FED");
  check("Cash Flow with only a manual home ⇒ MANUAL_ONLY", classifyPerspectiveEmpty("cashFlow", [house], false).reason === "MANUAL_ONLY");
  check("Cash Flow with only a wallet ⇒ NOT_FED (not manual-only)", classifyPerspectiveEmpty("cashFlow", [wallet], false).reason === "NOT_FED");
  check("importing bank ⇒ PROCESSING on Cash", classifyPerspectiveEmpty("cash", [src({ state: "IMPORTING" })], false).reason === "PROCESSING");
  check("never-updated bank ⇒ PROCESSING, not a zero", classifyPerspectiveEmpty("spending", [src({ state: "NEVER_UPDATED" })], false).reason === "PROCESSING");
  check("reconnect-needed card ⇒ FAILED on Debt", classifyPerspectiveEmpty("debt", [src({ state: "NEEDS_RECONNECT", feeds: ["liabilities"] })], false).reason === "FAILED");
  check("a failing WALLET does not make Debt look failed (scoped by population)",
    classifyPerspectiveEmpty("debt", [card, src({ kind: "WALLET", state: "SYNC_INCOMPLETE", feeds: ["digitalAssets"] })], false).reason === null);
  check("failed sources are reported by grant-filtered label only", JSON.stringify(classifyPerspectiveEmpty("cash", [src({ state: "CONNECTION_ERROR" })], false).sources) === JSON.stringify([{ label: "Chase", state: "CONNECTION_ERROR", lastUpdatedAt: "2026-10-28T00:00:00Z", actionable: true }]));
}

console.log("populations");
{
  check("investments view is fed by brokerage and crypto", sourceFeeds(src({ feeds: ["investments"] }), "investments") && sourceFeeds(wallet, "investments"));
  check("net worth is fed by everything with a balance", [bank, card, wallet, house].every((s) => sourceFeeds(s, "netWorth")));
  check("a source with no population info may feed any balance view", sourceFeeds(src({ feeds: undefined }), "debt"));
}

console.log("copy and route");
{
  const text = JSON.stringify(EMPTY_COPY);
  check("copy carries no codes or provider vocabulary", !/[A-Z]{3,}_[A-Z]/.test(text.replace(/"(NO_SOURCES|NOT_FED|MANUAL_ONLY|PROCESSING|FAILED)"/g, "")) && !/plaid|error code/i.test(text));
  check("processing copy says the user may leave", /you can leave this page/.test(EMPTY_COPY.PROCESSING.body));
  const route = readFileSync(path.join(process.cwd(), "app/api/spaces/[id]/data-health/route.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  check("route: any ACTIVE member, GET only, the Brief's own loader, no-store",
    /requireSpaceAction\(spaceId, "perspective:read"\)/.test(route) && /loadSpaceDataHealth\(tx/.test(route) && /no-store/.test(route) && !/export (const|async function) (POST|PUT|PATCH|DELETE)/.test(route));
  check("route returns sources only (no accounts, balances or ids)", /NextResponse\.json\(\{ sources: health\.sources \}/.test(route));
}

if (failures > 0) { console.error(`\nperspective-empty-state: ${failures} failed.`); process.exit(1); }
console.log("\nperspective-empty-state: all checks passed.");
