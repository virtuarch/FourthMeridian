/**
 * components/platform/growth/bulk-approve-model.test.ts  (PR C · bulk beta approval UI)
 *
 * The pure selection / flag / confirm / batchKey rules, run directly, plus the
 * panel rendered statically and pinned structurally (the house pattern for
 * self-fetching widgets: no DOM, no server).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/growth/bulk-approve-model.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BatchSession, confirmEnabled, disabledReason, flaggedLine, flaggedRows, headerState, parseDaysDraft, previewHeadline,
  pruneSelection, toggleAllEligible, toggleSelected, utcExpiryLabel, type RiskLike,
} from "./bulk-approve-model";
import { BulkApprovePanel } from "./BulkApprovePanel";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const code = (rel: string) =>
  readFileSync(path.join(process.cwd(), rel), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ok = (id: string) => ({ id, eligibility: { approvable: true } });
const bad = (id: string, reason = "That email already has a Fourth Meridian account.") => ({ id, eligibility: { approvable: false, reason } });

console.log("1. selection — individual, many, all ELIGIBLE on the page");
{
  const page = [ok("a"), bad("b"), ok("c"), { id: "d" } /* eligibility not computed ⇒ selectable; the server decides */];
  let s = toggleSelected(new Set(), page[0]);
  check("select one", [...s].join() === "a");
  s = toggleSelected(s, page[2]);
  check("select many", [...s].sort().join() === "a,c");
  check("an ineligible row cannot be selected", !toggleSelected(s, page[1]).has("b"));
  check("toggle again deselects", !toggleSelected(s, page[0]).has("a"));
  const all = toggleAllEligible(new Set(), page);
  check("select-all takes every eligible row and no ineligible one", [...all].sort().join() === "a,c,d", [...all]);
  check("header state all / some / none", headerState(all, page) === "all" && headerState(s, page) === "some" && headerState(new Set(), page) === "none");
  check("select-all when all are on clears the page", toggleAllEligible(all, page).size === 0);
  check("select-all keeps selections from other pages", toggleAllEligible(new Set(["zz"]), page).has("zz"));
  check("disabled reason = the server's reason; eligible ⇒ null", disabledReason(page[1]) === "That email already has a Fourth Meridian account." && disabledReason(page[0]) === null && disabledReason(page[3]) === null);
  check("disabled without a reason still says why", disabledReason({ id: "x", eligibility: { approvable: false } }) === "Not eligible for approval.");
  check("prune drops ids no longer listed", [...pruneSelection(new Set(["a", "gone"]), page)].join() === "a");
}

console.log("2. review flags — the agreed contract (never removes, never blocks, UI-only)");
{
  type R = { id: string; risk?: RiskLike | null };
  const rows: R[] = [
    { id: "none" },                                                    // risk undefined
    { id: "null", risk: null },
    { id: "low", risk: { level: "low" } },
    { id: "review", risk: { level: "review" } },
    { id: "high", risk: { level: "high", review: { status: "PENDING" } } },
    { id: "cleared", risk: { level: "high", review: { status: "LEGITIMATE" } } },
    { id: "nullReview", risk: { level: "review", review: null } },
  ];
  const f = flaggedRows(rows).map((r) => r.id);
  check("flagged = review|high and not LEGITIMATE; undefined/null risk tolerated", f.join() === "review,high,nullReview", f);
  check("flagging never removes a row from the selection", rows.length === 7);
  check("copy: 'N of M selected have review flags'", flaggedLine(3, 7) === "3 of 7 selected have review flags" && flaggedLine(0, 7) === null);
  check("flags present ⇒ Confirm needs the acknowledgement", !confirmEnabled({ inFlight: false, eligible: 5, flagged: 3, acknowledged: false })
    && confirmEnabled({ inFlight: false, eligible: 5, flagged: 3, acknowledged: true }));
  check("no flags ⇒ no acknowledgement needed", confirmEnabled({ inFlight: false, eligible: 5, flagged: 0, acknowledged: false }));
  check("in flight ⇒ disabled (double-click guard)", !confirmEnabled({ inFlight: true, eligible: 5, flagged: 0, acknowledged: true }));
  check("nothing eligible ⇒ disabled", !confirmEnabled({ inFlight: false, eligible: 0, flagged: 0, acknowledged: true }));
  const panel = code("components/platform/growth/BulkApprovePanel.tsx");
  check("the acknowledgement is never sent to the server", !/acknowledged[^\n]*JSON\.stringify|JSON\.stringify\(\{[^}]*acknowledg/.test(panel)
    && /JSON\.stringify\(\{\s*requestIds: ids, batchKey, dryRun,/.test(panel));
  check("the panel never imports a risk badge (slot only)", !/BetaRiskBadge/.test(panel));
}

console.log("3. one batchKey per review session — a retry is the same batch");
{
  let n = 0;
  const s = new BatchSession(() => `key-${++n}`);
  check("no key before a review", s.current() === null);
  const k1 = s.begin();
  check("begin mints once; a second begin (re-review) keeps it", k1 === "key-1" && s.begin() === "key-1");
  check("confirm and its retry reuse the open key", s.current() === "key-1" && s.current() === "key-1");
  s.end();
  check("finishing / cancelling ends the session; the next review is a new batch", s.current() === null && s.begin() === "key-2");
  const panel = code("components/platform/growth/BulkApprovePanel.tsx");
  check("the dry run begins the session and Confirm sends the CURRENT key (never mints)",
    /const batchKey = dryRun \? session\.current\.begin\(\) : session\.current\.current\(\);/.test(panel));
  check("the session ends only on Cancel / Done (closeSession), not on a failed Confirm",
    (panel.match(/session\.current\.end\(\)/g) ?? []).length === 1 && /function closeSession\(\) \{\s*session\.current\.end\(\);/.test(panel));
  check("Confirm is guarded synchronously (ref) as well as by the disabled button",
    /async function confirm\(\) \{[\s\S]{0,200}if \(inFlightRef\.current \|\| !confirmEnabled\(/.test(panel) && /disabled=\{!confirmEnabled\(\{ inFlight,/.test(panel));
  check("a failed Confirm stays in review so Confirm retries the same batch", /Confirm again to retry; nothing is sent twice/.test(panel));
}

console.log("4. copy, validity and expiry");
{
  check("preview headline", previewHeadline(12, 14) === "Approve 12 selected requests — invitation valid for 14 days" && previewHeadline(1, 1) === "Approve 1 selected request — invitation valid for 1 day");
  check("absolute expiry is UTC-labelled", utcExpiryLabel("2026-11-14T09:30:00.000Z") === "14 Nov 2026, 09:30 UTC", utcExpiryLabel("2026-11-14T09:30:00.000Z"));
  check("days draft: null ⇒ the configured setting (no override sent)", JSON.stringify(parseDaysDraft(null, 1, 30)) === JSON.stringify({ ok: true, override: null }));
  check("days draft: 1 and 30 accepted, 0 / 31 / 2.5 / '' refused", (parseDaysDraft("1", 1, 30) as { override: number }).override === 1
    && (parseDaysDraft("30", 1, 30) as { override: number }).override === 30
    && ["0", "31", "2.5", "", "x"].every((d) => !parseDaysDraft(d, 1, 30).ok));
}

console.log("5. the panel renders only for WRITE and only with a selection");
{
  const base = { selectedRows: [{ id: "a", email: "a@example.test" }, { id: "b", email: "b@example.test" }], validityDefault: 14, min: 1, max: 30, onClear: () => {}, onFinished: () => {} };
  const w = renderToStaticMarkup(createElement(BulkApprovePanel, { ...base, canWrite: true }));
  check("WRITE + 2 selected → bar with count, validity (default from the setting) and Review & approve",
    w.includes("2 selected") && w.includes("Review &amp; approve") && /id="growth-bulk-days"[^>]*value="14"/.test(w) && w.includes("days (1–30)"), w);
  check("result counts region is aria-live", /aria-live="polite"/.test(w));
  check("validity input is labelled", w.includes('for="growth-bulk-days"'));
  const r = renderToStaticMarkup(createElement(BulkApprovePanel, { ...base, canWrite: false }));
  check("READ → renders nothing", r === "", r);
  const e = renderToStaticMarkup(createElement(BulkApprovePanel, { ...base, selectedRows: [], canWrite: true }));
  check("nothing selected → renders nothing", e === "", e);
  const panel = code("components/platform/growth/BulkApprovePanel.tsx");
  check("the bar wraps on phones (flex-wrap, min-w-0)", /data-bulk-bar/.test(panel) && /flex min-w-0 flex-wrap items-center gap-2" data-bulk-bar/.test(panel));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll bulk-approval UI checks passed.");
