/**
 * lib/platform/admission/connection-establishment.test.ts  (OPS-2D-4A)
 *
 * Connection establishment and initial ingestion are two operations that happen
 * to share a function.
 *
 * `performPlaidTokenExchange` exchanges a ONE-TIME public token, persists the
 * item, institution and accounts — and then pulls holdings and transactions.
 * Before this slice a single admission gate would have been wrong in both
 * directions at once: too broad, because a paused ingestion should not reject a
 * customer who just finished a Link flow; too narrow, because the ingestion half
 * plainly must stop.
 *
 * The failure modes this guards are specific and all quiet:
 *
 *   - a provider ingestion call slipping past the gate (holdings especially —
 *     it is not obviously "ingestion" at a glance, it sits mid-function);
 *   - the one-time token being spent before a known platform-wide denial, which
 *     costs the customer the entire Link flow to reach the same refusal;
 *   - the connection being recorded as READY when nothing was ever ingested;
 *   - the deferred connection being invisible to recovery, so it stays pending
 *     forever and the only way out is reconnecting.
 *
 * Run:  npx tsx lib/platform/admission/connection-establishment.test.ts
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { evaluateAdmission } from "./policy-core";
import type { ControlPlaneFacts, FactState } from "./types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
/** Comments AND imports stripped — every position is a call site. */
const body = (rel: string) => code(rel).replace(/^import[\s\S]*?;$/gm, "");
const exists = (rel: string) => { try { statSync(path.join(ROOT, rel)); return true; } catch { return false; } };
const at = (s: string, re: RegExp) => { const m = re.exec(s); return m ? m.index : -1; };

const EXCHANGE = "lib/plaid/exchangeToken.ts";
const LINK_ROUTE = "app/api/plaid/exchange-token/route.ts";
const ADMIN_ROUTE = "app/api/admin/plaid/exchange-expanded-history-token/route.ts";

/**
 * Every Plaid endpoint reached from this path, classified.
 *
 * The classification is the substance of the slice: an ingestion pause must
 * permit exactly the first group and none of the second.
 */
const PROVIDER_CALLS = {
  connection: [
    { call: "itemPublicTokenExchange", why: "the exchange itself — there is no connection without it" },
    { call: "accountsGet",             why: "the account inventory; a connection with unknown accounts is not established" },
    { call: "itemRemove",              why: "duplicate-gate rollback — un-does a connection that must not exist" },
  ],
  ingestion: [
    { call: "syncInvestmentsForItem",  why: "wraps investmentsHoldingsGet — provider DATA" },
    { call: "syncTransactionsForItem", why: "wraps transactionsSync — provider DATA" },
  ],
} as const;

const facts = (m: FactState, i: FactState): ControlPlaneFacts => ({
  maintenanceMode: { key: "maintenance_mode", state: m, raw: m === "ON" ? "true" : m === "OFF" ? "false" : null },
  ingestionPaused: { key: "ingestion_paused", state: i, raw: i === "ON" ? "true" : i === "OFF" ? "false" : null },
});

function main() {
  // ── 1. The stage boundary exists and is declarative ─────────────────────────
  console.log("1. the two stages are named, and the module only NAMES them");
  {
    const src = code(EXCHANGE);
    check("declares CONNECTION_ESTABLISHMENT", /admitOperationalWork\(\{ work: "CONNECTION_ESTABLISHMENT" \}\)/.test(src));
    check("declares REFRESH_EXECUTION for the ingestion half", /admitOperationalWork\(\{ work: "REFRESH_EXECUTION" \}\)/.test(src));

    // It must not decide anything itself — no local fact reads, no local
    // verdicts, no caller-specific policy branch.
    check("reads no control-plane setting",
      !/"(maintenance_mode|ingestion_paused)"/.test(src) &&
      !/PlatformSettingKey\.(MAINTENANCE_MODE|INGESTION_PAUSED)/.test(src));
    check("evaluates nothing itself", !/evaluateAdmission\(|readFactState\(|resolveControlPlaneFacts\(/.test(src));
    check("constructs no verdict", !/decision:\s*"(ADMIT|DENY)"/.test(src));
    check("writes no reason literal", !/"(MAINTENANCE_MODE|INGESTION_PAUSED|CONTROL_PLANE_[A-Z_]+)"/.test(src));
    // The ONE derived branch is about the OPERATION (does it sync inline?), not
    // about who is calling — a caller-keyed branch would be policy in a producer.
    check("branches on the operation, never on the caller",
      !/(isAdmin|adminFlow|caller ===|params\.userId ===)[\s\S]{0,120}admitOperationalWork/.test(src));
  }

  // ── 2. The one-time token is never spent on a known denial ──────────────────
  console.log("2. a known denial never consumes the public token");
  {
    const s = body(EXCHANGE);
    const connectAdm = at(s, /admitOperationalWork\(\{ work: "CONNECTION_ESTABLISHMENT" \}\)/);
    const ingestAdm  = at(s, /admitOperationalWork\(\{ work: "REFRESH_EXECUTION" \}\)/);
    const exchange   = at(s, /itemPublicTokenExchange\(/);
    const itemWrite  = at(s, /db\.plaidItem\.upsert\(/);

    check("connection admission precedes the token exchange", connectAdm >= 0 && connectAdm < exchange);
    check("ingestion admission is ALSO resolved before the token exchange", ingestAdm >= 0 && ingestAdm < exchange);
    check("both precede any item persistence", Math.max(connectAdm, ingestAdm) < itemWrite);

    // The inline-ingestion caller aborts up front rather than half-completing.
    check("an inline-ingestion caller aborts before the exchange when ingestion is denied",
      /decision === "DENY" && !deferHistorySync[\s\S]{0,200}throw new AdmissionDeniedError/.test(s));
    check("the abort throws a typed error, not a Plaid-shaped one",
      /class AdmissionDeniedError extends Error/.test(code(EXCHANGE)));
  }

  // ── 3. Provider-call accounting ─────────────────────────────────────────────
  console.log("3. every provider call is classified, and ingestion calls are gated");
  {
    const s = body(EXCHANGE);
    for (const c of PROVIDER_CALLS.connection) {
      check(`${c.call}: present and UNGATED (${c.why})`,
        new RegExp(`${c.call}\\(`).test(s) &&
        !new RegExp(`ingestionAdmitted[\\s\\S]{0,80}${c.call}\\(`).test(s));
    }
    // POSITIONAL, not proximity-based. An earlier version of this check asked
    // whether the token "ingestionAdmitted" appeared shortly before the call —
    // which its own `const` declaration satisfied, so a call inserted ABOVE the
    // gate still passed. Each ingestion call is now pinned to the specific
    // construct that guards it, and EVERY occurrence must sit after it.
    const ternary = at(s, /ingestionAdmitted\s*\n?\s*\?\s*await syncInvestmentsForItem\(/);
    check("syncInvestmentsForItem runs only inside the ingestionAdmitted ternary", ternary >= 0);
    check("syncInvestmentsForItem appears exactly once",
      (s.match(/syncInvestmentsForItem\(/g) ?? []).length === 1);

    const deniedBranch = at(s, /if \(!ingestionAdmitted\) \{/);
    check("the denied-ingestion branch exists", deniedBranch >= 0);
    const txCalls = [...s.matchAll(/syncTransactionsForItem\(/g)].map((m) => m.index!);
    check(`syncTransactionsForItem called exactly once (got ${txCalls.length})`, txCalls.length === 1);
    check("every syncTransactionsForItem call sits AFTER the ingestion gate",
      txCalls.length > 0 && txCalls.every((i) => i > deniedBranch),
      `gate@${deniedBranch} calls@${txCalls.join(",")}`);
    // …and no ingestion call may precede the gate at all.
    for (const c of PROVIDER_CALLS.ingestion) {
      const first = at(s, new RegExp(`${c.call}\\(`));
      check(`${c.call}: present and never before the gate (${c.why})`,
        first >= 0 && first > at(s, /const ingestionAdmitted =/));
    }
    // Nothing else may reach Plaid from this module.
    const plaidCalls = [...s.matchAll(/plaidClient\.(\w+)\(/g)].map((m) => m[1]);
    const classified = new Set<string>(["itemPublicTokenExchange", "accountsGet", "itemRemove"]);
    const unclassified = plaidCalls.filter((c) => !classified.has(c));
    check(`every direct plaidClient call is classified (found: ${plaidCalls.join(", ") || "none"})`,
      unclassified.length === 0, unclassified.join(", "));
  }

  // ── 4. Denied ingestion records the truth, and nothing more ─────────────────
  console.log("4. a deferred ingestion is pending, not ready, and not failed");
  {
    const s = code(EXCHANGE);
    check("the pending marker is set when ingestion is denied",
      /const syncIncompleteAt = deferHistorySync \|\| !ingestionAdmitted \? new Date\(\) : null;/.test(s));
    check("the denied ingestion intent is ledgered", /recordAdmissionDenial\(/.test(s));
    check("the ledgered denial carries the canonical reason",
      /admissionReason:\s*ingestionAdmission\.reason!/.test(s));
    check("the result carries the typed deferral", /ingestionDeferred:\s*\{/.test(s));
    check("the audit names the outcome rather than reporting an empty success",
      /outcome:\s*"connection-established-ingestion-deferred"/.test(s));

    // It must NOT look like a provider failure. Note the distinction: this path
    // DOES mark the item healthy — a connection that established fine is
    // healthy, it simply has no data yet. What must never happen is a
    // DEGRADATION, or a failure classified from a policy decision.
    check("the item is never degraded",
      !/status:\s*PlaidItemStatus\.(ERROR|NEEDS_REAUTH|REVOKED)/.test(s));
    check("no provider error is classified from a policy outcome",
      !/classifyPlaidErrorForHealth/.test(s));
    check("the owner is not told a sync failed", !/notifyItemSyncFailed/.test(s));
    check("no sync issue is recorded", !/recordSyncIssue\(|syncIssue\.create\(/.test(s));
    // …and the healthy transition belongs to the CONNECTION stage, so a
    // deferred ingestion still leaves the connection marked ACTIVE.
    const b = body(EXCHANGE);
    check("setPlaidItemHealth is called with ACTIVE only",
      /setPlaidItemHealth\([\s\S]{0,120}status:\s*PlaidItemStatus\.ACTIVE/.test(b));
    check("the healthy transition runs in the connection stage, ungated by ingestion",
      at(b, /setPlaidItemHealth\(/) < at(b, /ingestionAdmitted\s*$/m) ||
      !/ingestionAdmitted[\s\S]{0,200}setPlaidItemHealth\(/.test(b));
    // …and it must not claim readiness.
    check("snapshots are not regenerated over an empty import",
      /if \(ingestionAdmitted\) spacesSnapshotted = await regenerateSnapshotsForAccounts/.test(s));
  }

  // ── 5. The pending state is DISCOVERABLE by existing recovery ───────────────
  //
  // Load-bearing. A deferred connection that nothing rediscovers is worse than a
  // refusal: the customer believes they connected and the data never arrives.
  console.log("5. recovery rediscovers a policy-deferred connection");
  {
    // The marker this slice sets is the exact one the recovery job selects on…
    const recovery = code("jobs/resume-stale-imports.ts");
    check("resume-stale-imports selects on syncIncompleteAt", /syncIncompleteAt:\s*\{ lt: cutoff \}/.test(recovery));
    check("…and only for ACTIVE items of live users",
      /status:\s*PlaidItemStatus\.ACTIVE/.test(recovery) && /deactivatedAt: null/.test(recovery));
    // …and the status derivation renders it as importing, never ready.
    const status = code("lib/sync/status.ts");
    // Stated as INTENT, not as the literal branch. The Phase B follow-up split
    // the incomplete case into importing vs sync_deferred; what must hold — and
    // what this has always been about — is that a pending import NEVER reads as
    // ready. Pinning the old one-liner made a correct refinement look like a
    // regression.
    check("an incomplete import never reads as ready",
      /if \(item\.syncIncompleteAt !== null\) \{/.test(status) &&
      /"sync_deferred" : "importing"/.test(status) &&
      !/syncIncompleteAt !== null\) return "ready"/.test(status));
    // …and the recovery path itself now asks admission, so it resumes only once
    // the pause is lifted rather than hammering a paused provider every 5 min.
    check("the recovery path is itself admission-gated (resumes only when unpaused)",
      /admitOperationalWork\(/.test(recovery));
    // …and it drives the item through the shared wrapper — no new Link flow.
    check("recovery resumes via the shared wrapper, requiring no second token exchange",
      /syncPlaidItemFromWebhook\(/.test(recovery) && !/itemPublicTokenExchange/.test(recovery));
  }

  // ── 6. Caller contracts ─────────────────────────────────────────────────────
  console.log("6. both callers translate the outcome honestly");
  {
    const link = code(LINK_ROUTE);
    check("customer Link surfaces the deferral", /ingestionDeferred:\s*result\.ingestionDeferred/.test(link));
    check("customer Link answers 503 on a pre-token denial",
      /err instanceof AdmissionDeniedError[\s\S]{0,260}status:\s*503/.test(link));
    // A policy denial must not be parsed as a Plaid error.
    const li = link.indexOf("AdmissionDeniedError");
    const lp = link.indexOf("parsePlaidError(err");
    check("customer Link checks admission BEFORE the Plaid error parser", li >= 0 && li < lp);

    const admin = code(ADMIN_ROUTE);
    check("admin Expand-History answers 503 on denial",
      /exchangeErr instanceof AdmissionDeniedError[\s\S]{0,300}status:\s*503/.test(admin));
    const ai = admin.indexOf("AdmissionDeniedError");
    const ap = admin.indexOf("parsePlaidError(");
    check("admin checks admission BEFORE the Plaid error parser", ai >= 0 && ai < ap);
    // Expand History is ingestion-only in purpose: it must NOT defer.
    check("admin Expand-History does not sync history out-of-band",
      !/deferHistorySync:\s*true/.test(admin));
  }

  // ── 7. Authorization still precedes admission at both callers ───────────────
  console.log("7. authorization precedes admission disclosure");
  {
    const link = body(LINK_ROUTE);
    check("customer Link authenticates before calling the exchange",
      at(link, /await requireUser\(\)|getSpaceContext\(/) < at(link, /performPlaidTokenExchange\(/));
    const admin = body(ADMIN_ROUTE);
    check("admin route requires SYSTEM_ADMIN before calling the exchange",
      at(admin, /await requireSystemAdmin\(\)/) >= 0 &&
      at(admin, /await requireSystemAdmin\(\)/) < at(admin, /performPlaidTokenExchange\(/));
    // No role or capability may skip the gate.
    for (const f of [EXCHANGE, LINK_ROUTE, ADMIN_ROUTE]) {
      check(`${f}: no role/capability short-circuits admission`,
        !/(SYSTEM_ADMIN|hasPlatformAccess|LEVEL_RANK)[\s\S]{0,160}admitOperationalWork/.test(code(f)));
    }
  }

  // ── 8. The behavioural contract, through the real evaluator ─────────────────
  console.log("8. the verdicts the two stages actually receive");
  {
    const paused = facts("OFF", "ON");
    check("ingestion pause: connection ADMITTED",
      evaluateAdmission({ work: "CONNECTION_ESTABLISHMENT" }, paused).decision === "ADMIT");
    check("ingestion pause: ingestion DENIED with the typed reason",
      evaluateAdmission({ work: "REFRESH_EXECUTION" }, paused).reason === "INGESTION_PAUSED");

    const maint = facts("ON", "OFF");
    check("maintenance: connection DENIED (so the token is never spent)",
      evaluateAdmission({ work: "CONNECTION_ESTABLISHMENT" }, maint).reason === "MAINTENANCE_MODE");

    const normal = facts("MISSING", "MISSING");
    check("nothing configured: both stages ADMITTED (existing behaviour preserved)",
      evaluateAdmission({ work: "CONNECTION_ESTABLISHMENT" }, normal).decision === "ADMIT" &&
      evaluateAdmission({ work: "REFRESH_EXECUTION" }, normal).decision === "ADMIT");

    for (const bad of ["INVALID", "UNAVAILABLE"] as FactState[]) {
      check(`${bad} control state denies connection establishment too (fails closed)`,
        evaluateAdmission({ work: "CONNECTION_ESTABLISHMENT" }, facts("OFF", bad)).decision === "DENY");
    }
  }

  // ── 9. Census + scope ───────────────────────────────────────────────────────
  console.log("9. the census absorbed the eighth producer; scope held");
  {
    check(`${EXCHANGE}: now consumes the canonical evaluator`, /admitOperationalWork\(/.test(code(EXCHANGE)));
    // Legacy bypasses stay bypasses — D4A must not quietly absorb them.
    for (const f of ["app/api/jobs/sync-banks/route.ts", "app/api/jobs/process-deletions/route.ts",
                     "app/api/jobs/fetch-fx-rates/route.ts", "app/api/jobs/dispatch/route.ts"]) {
      if (!exists(f)) { check(`${f}: exists`, false); continue; }
      check(`${f}: still an identified legacy bypass`, !/admitOperationalWork\(/.test(code(f)));
    }
    // No control surface, no override.
    for (const f of [EXCHANGE, LINK_ROUTE, ADMIN_ROUTE]) {
      check(`${f}: no control mutation or override`,
        !/setMaintenanceMode|setIngestionPaused|admissionOverride|forceAdmit|bypassAdmission/.test(code(f)));
    }
    // Design Lab / prototype untouched.
    for (const f of [EXCHANGE, LINK_ROUTE, ADMIN_ROUTE]) {
      check(`${f}: imports nothing from prototype/ or Growth`,
        !/from\s+["']@?\/?prototype\//.test(code(f)) &&
        !/GrowthStagePanel|FunnelStages|growth-funnel/.test(code(f)));
    }
  }

  if (failures > 0) {
    console.error(`\nconnection-establishment.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nconnection-establishment.test: all passed.");
}

main();
