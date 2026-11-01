/**
 * lib/platform/onboarding/import-status-core.test.ts  (PB-7)
 *
 * The one import rule, the 2026-11-01 sequence as a fixture, the CS timeline
 * DTO's privacy, and that the Customer Success "Recently joined" totals and
 * the Platform Ops tile agree for the same items.
 *
 * Run: npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/onboarding/import-status-core.test.ts
 */

import {
  IMPORT_STATUSES, STALL_AFTER_MS, deriveImportStatus, importExecutionFact, importHealthDot, tallyImportStatuses,
  type ImportEvidence, type ImportItemFacts, type ImportedItem,
} from "./import-status-core";
import { STALE_EXECUTION_ERROR_SUMMARY } from "@/lib/plaid/stale-execution.core";
import { buildOnboardingTimeline } from "@/lib/platform/customer/onboarding-core";
import { buildRecentlyJoinedRows } from "@/lib/platform/customer/recently-joined-core";
import { buildNewConnectionImports } from "@/lib/platform/ops/new-connection-imports-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const D = (iso: string) => new Date(iso);
const NOW = D("2026-11-01T22:00:00Z");

function item(over: Partial<ImportItemFacts> = {}): ImportItemFacts {
  return {
    id: "item-wf", createdAt: D("2026-11-01T20:38:55Z"), status: "ACTIVE", errorCode: null,
    syncIncompleteAt: null, historyBuildStartedAt: null, completedSyncCount: 2, syncImportedCount: 1388, ...over,
  };
}
const A = importExecutionFact({ id: "exec-A", trigger: "RECONNECT", profile: "RECONNECT", startedAt: D("2026-11-01T20:39:00Z"),
  completedAt: D("2026-11-01T21:00:00Z"), overallStatus: "FAILED", failureCategory: "UNKNOWN", errorSummary: STALE_EXECUTION_ERROR_SUMMARY });
const B = importExecutionFact({ id: "exec-B", trigger: "RESUME", profile: "IMPORT_RECOVERY", startedAt: D("2026-11-01T20:50:30Z"),
  completedAt: D("2026-11-01T20:55:00Z"), overallStatus: "SUCCEEDED", failureCategory: null, errorSummary: null });
const PROD: ImportEvidence = { executions: [A, B], firstWealthRegenAt: D("2026-11-01T20:55:00Z") };

function main() {
  console.log("the Production sequence (20:44 killed → 20:55 resumed → 21:00 reaped)");
  {
    const v = deriveImportStatus(item(), PROD, NOW);
    check("RECOVERED, not failed", v.status === "recovered", v.status);
    check("reason: interrupted (process ended mid-run)", v.reason === "INTERRUPTED");
    check("1,388 transactions, completed 20:55, wealth regen 20:55", v.transactions === 1388
      && v.completedAt?.toISOString() === "2026-11-01T20:55:00.000Z" && v.firstWealthRegenAt?.toISOString() === "2026-11-01T20:55:00.000Z");
    check("2 attempts, 1 ended mid-run", v.executions === 2 && v.reapedExecutions === 1);
    // Mid-incident snapshots: at 20:47 (A dead, still RUNNING, marker set) and 20:52 (B running).
    const at2047 = deriveImportStatus(item({ syncIncompleteAt: D("2026-11-01T20:38:55Z"), completedSyncCount: 0, syncImportedCount: 400 }),
      { executions: [{ ...A, overallStatus: "RUNNING", completedAt: null, reaped: false }], firstWealthRegenAt: null }, D("2026-11-01T20:47:00Z"));
    check("20:47 — in progress (nothing has said it failed yet)", at2047.status === "in_progress" && !at2047.interrupted);
    const at2058 = deriveImportStatus(item(), { executions: [{ ...A, overallStatus: "RUNNING", completedAt: null, reaped: false }, B], firstWealthRegenAt: null }, D("2026-11-01T20:58:00Z"));
    check("20:58 — complete via a RESUME already reads recovered (before the reap)", at2058.status === "recovered");
  }

  console.log("the other statuses");
  {
    const clean = deriveImportStatus(item(), { executions: [{ ...B, trigger: "RECONNECT", profile: "RECONNECT" }], firstWealthRegenAt: null }, NOW);
    check("clean first pass → complete", clean.status === "complete" && clean.reason === null);
    const interrupted = deriveImportStatus(item({ syncIncompleteAt: D("2026-11-01T20:38:55Z"), completedSyncCount: 0 }), { executions: [A], firstWealthRegenAt: null }, D("2026-11-01T21:05:00Z"));
    check("reaped, resume pending → in progress + interrupted", interrupted.status === "in_progress" && interrupted.interrupted && interrupted.reason === "INTERRUPTED");
    const reauth = deriveImportStatus(item({ status: "NEEDS_REAUTH", syncIncompleteAt: D("2026-11-01T20:38:55Z"), completedSyncCount: 0 }), null, NOW);
    check("needs re-auth while incomplete → failed REAUTH_REQUIRED", reauth.status === "failed" && reauth.reason === "REAUTH_REQUIRED");
    const stalled = deriveImportStatus(item({ syncIncompleteAt: D("2026-10-30T00:00:00Z"), completedSyncCount: 0 }), { executions: [], firstWealthRegenAt: null },
      new Date(D("2026-10-30T00:00:00Z").getTime() + STALL_AFTER_MS + 1));
    check("incomplete > 24 h → failed STALLED", stalled.status === "failed" && stalled.reason === "STALLED");
    const stalledReaped = deriveImportStatus(item({ syncIncompleteAt: D("2026-11-01T20:38:55Z"), completedSyncCount: 0 }), { executions: [A], firstWealthRegenAt: null }, D("2026-11-03T00:00:00Z"));
    check("…with the newest failure's category when one exists", stalledReaped.status === "failed" && stalledReaped.reason === "INTERRUPTED");
    check("REVOKED → removed", deriveImportStatus(item({ status: "REVOKED" }), PROD, NOW).status === "removed");
    check("an ERROR on a COMPLETE import is not an onboarding failure", deriveImportStatus(item({ status: "ERROR" }), { executions: [B], firstWealthRegenAt: null }, NOW).status !== "failed");
    const later = deriveImportStatus(item(), { executions: [B, { ...A, startedAt: D("2026-11-05T00:00:00Z") }], firstWealthRegenAt: null }, NOW);
    check("executions outside the 48 h import window are ignored", later.executions === 1);
  }

  console.log("dot + tally");
  check("red > amber > green; none without a live bank", importHealthDot([{ status: "complete" }, { status: "failed" }]) === "red"
    && importHealthDot([{ status: "complete" }, { status: "recovered" }]) === "amber"
    && importHealthDot([{ status: "complete" }]) === "green" && importHealthDot([{ status: "removed" }]) === "none" && importHealthDot([]) === "none");
  check("tally carries every status", Object.keys(tallyImportStatuses([])).join(",") === IMPORT_STATUSES.join(","));

  console.log("CS timeline DTO — counts, kinds, timestamps only");
  {
    const wf: ImportedItem = { ...item(), institutionName: "Wells Fargo", userId: "u1", verdict: deriveImportStatus(item(), PROD, NOW) };
    const t = buildOnboardingTimeline({
      user: { createdAt: D("2026-11-01T20:30:00Z"), emailVerifiedAt: D("2026-11-01T20:31:00Z") },
      request: { invitedAt: D("2026-10-31T10:00:00Z"), redeemedAt: D("2026-11-01T20:30:00Z") },
      firstSessionAt: D("2026-11-01T20:32:00Z"), firstAiTurnAt: null, firstBriefAt: null,
      banks: [wf], wallets: [],
    });
    check("invited; ordered registered → verified → session → linked → import → wealth", t.invited
      && t.events.map((e) => e.kind).join(",") === "registered,email_verified,first_session,linked,import,wealth_regen");
    check("the import event says recovered with 1,388 transactions", t.events.some((e) => e.kind === "import" && /recovered after interruption · 1,388 transactions/.test(e.label)));
    check("pending names the steps not reached", t.pending.includes("No AI conversation yet") && t.pending.includes("No Brief viewed yet"));
    const json = JSON.stringify(t);
    check("no token, cursor, amount, merchant or transaction content field", !/encryptedToken|cursor|amount|merchant|description|accessToken|"name"/i.test(json));
    const keys = new Set<string>();
    const walk = (v: unknown) => { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
    walk(t);
    const ALLOWED = new Set(["registeredAt", "invited", "emailVerifiedAt", "firstSessionAt", "firstAiTurnAt", "firstBriefAt", "connections", "importHealth", "events", "pending", "floor",
      "id", "kind", "label", "linkedAt", "importStatus", "interrupted", "reason", "reasonLabel", "transactions", "importCompletedAt", "firstWealthRegenAt", "attempts", "interruptedAttempts",
      "at", "tone", "connectionId", ...Array.from({ length: 20 }, (_, i) => String(i))]);
    const extra = [...keys].filter((k) => !ALLOWED.has(k));
    check("the DTO's keys are exactly the allowlist", extra.length === 0, extra.join(","));
  }

  console.log("Recently joined (CS) ⟷ New-connection imports (Ops): same items, same counts");
  {
    const mk = (id: string, userId: string, over: Partial<ImportItemFacts>, ev: ImportEvidence | null): ImportedItem => {
      const f = item({ id, ...over });
      return { ...f, institutionName: `Bank ${id}`, userId, verdict: deriveImportStatus(f, ev, NOW) };
    };
    const items = [
      mk("i1", "u1", {}, PROD),
      mk("i2", "u1", {}, { executions: [{ ...B, trigger: "RECONNECT" }], firstWealthRegenAt: null }),
      mk("i3", "u2", { syncIncompleteAt: D("2026-11-01T21:50:00Z"), completedSyncCount: 0 }, null),
      mk("i4", "u3", { status: "NEEDS_REAUTH", syncIncompleteAt: D("2026-11-01T20:00:00Z"), completedSyncCount: 0 }, null),
    ];
    const users = ["u1", "u2", "u3", "u4"].map((id, i) => ({ id, email: `${id}@example.test`, name: null, username: id, createdAt: D(`2026-10-2${i + 5}T00:00:00Z`), emailVerifiedAt: null }));
    const facts = { firstSession: new Map(), firstConnection: new Map(), firstAiTurn: new Map(), firstBriefView: new Map(), lastEngaged: new Map(),
      invitedEmails: new Set(["u1@example.test"]), walletCount: new Map() };
    const cs = buildRecentlyJoinedRows({ windowDays: 14, total: 4, users, facts, imports: items, floor: false });
    const ops = buildNewConnectionImports(items.map((i) => i.verdict), { windowDays: 7, floor: false, checkedAt: NOW });
    check("per-status totals are identical", IMPORT_STATUSES.every((s) => cs.importTotals[s] === ops.byStatus[s]),
      JSON.stringify({ cs: cs.importTotals, ops: ops.byStatus }));
    check("started = the sum of the partition", ops.started === IMPORT_STATUSES.reduce((a, s) => a + ops.byStatus[s], 0));
    check("dots: u1 amber (recovered), u2 amber (in progress), u3 red, u4 none",
      cs.rows.map((r) => r.importHealth).join(",") === "amber,amber,red,none", cs.rows.map((r) => r.importHealth).join(","));
    check("invited vs uninvited", cs.rows[0].invited && !cs.rows[1].invited);
    check("failed reasons are counted by category", ops.failedReasons.REAUTH_REQUIRED === 1);
    const opsJson = JSON.stringify(ops);
    check("the Ops tile carries no identity (no user/item id, email, institution)", !/u[1-4]|i[1-4]"|example\.test|Bank |userId|email|institution/.test(opsJson), opsJson);
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main();
