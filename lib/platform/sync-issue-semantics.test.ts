/**
 * lib/platform/sync-issue-semantics.test.ts
 *
 * PRE-V26-PLAID-CLOSE Phase 4 — the SyncIssue semantics authority
 * (house pattern: standalone tsx, DB-free):
 *
 *   npx tsx lib/platform/sync-issue-semantics.test.ts
 *
 * §1–4 pin the derivation. §5 replays the FIFTEEN REAL ROWS in the local
 * database and asserts the reclassification the design promised: 15 "unresolved"
 * rows collapse to 0 active incidents, because none of them is one.
 * §6 pins the safety rules that protect financial truth:
 *   • only cursor-blocking conditions may auto-recover;
 *   • a superseded/orphaned row is never silently called "resolved";
 *   • internal repair failures never reach a member.
 */

import {
  classifySyncIssue, syncIssueState, isActiveIncident, isSupersededMismatch, stageOf,
} from "./sync-issue-semantics";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const LIVE = { referentExists: true, resolved: false };

// ── 1. The critical path — transaction persistence ──────────────────────────
console.log("1. Transaction persistence is the only critical domain");
{
  const row = { kind: "UPSERT_ERROR", provider: "PLAID",
                detail: { stage: "transaction-persist", runId: "r1", cursorBlocking: true } };
  const c = classifySyncIssue(row);
  check("domain transactions", c.domain === "transactions");
  check("severity critical", c.severity === "critical");
  check("nature condition", c.nature === "condition");
  check("customer-actionable", c.customerActionable === true);
  check("cursor-blocking", c.cursorBlocking === true);
  check("state active", syncIssueState(row, LIVE) === "active");

  const miss = { kind: "MISSING_ACCOUNT", provider: "PLAID",
                 detail: { stage: "transaction-persist", runId: "r1", cursorBlocking: true } };
  check("MISSING_ACCOUNT is equally critical", classifySyncIssue(miss).severity === "critical");
  check("MISSING_ACCOUNT is cursor-blocking", classifySyncIssue(miss).cursorBlocking === true);
}

// ── 2. The overload is split ────────────────────────────────────────────────
console.log("2. UPSERT_ERROR splits by stage — no enum values needed");
{
  const cases: [string, string, string][] = [
    ["opening-position-repair",      "investments", "error"],
    ["investment-import-repair",     "investments", "error"],
    ["investment-events-fetch",      "investments", "error"],
    ["reconstruction-repair",        "investments", "error"],
    ["investment-events-instrument", "investments", "error"],
    ["import-rollback-repair",       "imports",     "error"],
  ];
  for (const [stage, domain, severity] of cases) {
    const c = classifySyncIssue({ kind: "UPSERT_ERROR", provider: "PLAID", detail: { stage } });
    check(`${stage} → ${domain}/${severity}`, c.domain === domain && c.severity === severity);
    check(`${stage} is NOT customer-actionable`, c.customerActionable === false);
    check(`${stage} is NOT cursor-blocking`, c.cursorBlocking === false);
  }

  const wallet = classifySyncIssue({ kind: "UPSERT_ERROR", provider: "WALLET", detail: { stage: "price" } });
  check("provider WALLET wins over an ambiguous stage name", wallet.domain === "wallet");
  check("wallet failure is not customer-actionable", wallet.customerActionable === false);

  // THE requirement: a lost bank transaction and a non-fatal repair must never
  // be conflated.
  const txn  = classifySyncIssue({ kind: "UPSERT_ERROR", detail: { stage: "transaction-persist" } });
  const repair = classifySyncIssue({ kind: "UPSERT_ERROR", detail: { stage: "opening-position-repair" } });
  check("transaction loss ≠ investment repair (severity)", txn.severity !== repair.severity);
  check("transaction loss ≠ investment repair (domain)",   txn.domain !== repair.domain);
  check("transaction loss ≠ investment repair (member visibility)",
    txn.customerActionable !== repair.customerActionable);
}

// ── 3. Events never render as active degradation ────────────────────────────
console.log("3. EVENT vs CONDITION");
{
  const tomb = { kind: "REMOVED_TOMBSTONE", provider: "PLAID", detail: { runId: "r1", count: 8 } };
  const c = classifySyncIssue(tomb);
  check("tombstone severity info", c.severity === "info");
  check("tombstone nature event", c.nature === "event");
  check("tombstone state is evidence, NOT active", syncIssueState(tomb, LIVE) === "evidence");
  check("tombstone is not an active incident", isActiveIncident(tomb, LIVE) === false);
  check("tombstone never customer-facing", c.customerActionable === false);

  // Crucially: it is NOT reported as "resolved" either — it was never a problem.
  check("tombstone is not mislabelled 'recovered'",
    syncIssueState(tomb, { referentExists: true, resolved: true }) === "evidence");

  const mismatch = { kind: "BALANCE_TX_MISMATCH", provider: "PLAID", detail: { basis: "posted" } };
  check("posted-basis mismatch is a warning EVENT",
    classifySyncIssue(mismatch).severity === "warning" && classifySyncIssue(mismatch).nature === "event");
  check("a mismatch is never auto-resolvable (it observes one window)",
    syncIssueState(mismatch, LIVE) === "evidence");
}

// ── 4. Superseded + orphaned ────────────────────────────────────────────────
console.log("4. Superseded (retired rule) and orphaned (vanished subject)");
{
  const legacy = { kind: "BALANCE_TX_MISMATCH", provider: "PLAID", detail: { mismatch: 421.32 } };
  check("a mismatch without basis is superseded", isSupersededMismatch(legacy));
  check("state superseded", syncIssueState(legacy, LIVE) === "superseded");
  check("superseded is not active", isActiveIncident(legacy, LIVE) === false);

  const fixed = { kind: "BALANCE_TX_MISMATCH", provider: "PLAID", detail: { basis: "posted" } };
  check("a posted-basis mismatch is NOT superseded", !isSupersededMismatch(fixed));

  const orphan = { kind: "UPSERT_ERROR", provider: "PLAID", detail: { stage: "opening-position-repair" } };
  check("missing referent ⇒ orphaned",
    syncIssueState(orphan, { referentExists: false, resolved: false }) === "orphaned");
  check("orphaned is not active",
    isActiveIncident(orphan, { referentExists: false, resolved: false }) === false);
  check("orphaned outranks everything (a missing subject describes nothing)",
    syncIssueState({ kind: "UPSERT_ERROR", detail: { stage: "transaction-persist", cursorBlocking: true } },
                   { referentExists: false, resolved: false }) === "orphaned");
}

// ── 5. The fifteen real local rows, reclassified ────────────────────────────
console.log("5. The 15 real rows in the local database");
{
  // Verbatim shapes from `select kind, provider, detail from "SyncIssue"`.
  const REAL = [
    ...Array.from({ length: 8 }, () => ({
      kind: "UPSERT_ERROR", provider: "PLAID",
      detail: { stage: "opening-position-repair", error: "Cannot read properties of undefined (reading 'findMany')" },
      // financialAccountId "fa1" does not exist in FinancialAccount.
      referentExists: false,
    })),
    ...Array.from({ length: 5 }, () => ({
      kind: "REMOVED_TOMBSTONE", provider: "PLAID",
      detail: { count: 8, ids: ["a", "b"] }, referentExists: true,
    })),
    ...Array.from({ length: 2 }, () => ({
      kind: "BALANCE_TX_MISMATCH", provider: "PLAID",
      detail: { kind: "cash", mismatch: 421.32, threshold: 100 },  // no `basis` ⇒ legacy
      referentExists: true,
    })),
  ];

  const states = REAL.map((r) =>
    syncIssueState(r, { referentExists: r.referentExists, resolved: false }));
  const count = (s: string) => states.filter((x) => x === s).length;

  check("8 test-pollution rows → orphaned", count("orphaned") === 8, `${count("orphaned")}`);
  check("5 tombstones → evidence", count("evidence") === 5, `${count("evidence")}`);
  check("2 legacy mismatches → superseded", count("superseded") === 2, `${count("superseded")}`);
  check("ACTIVE INCIDENTS = 0 (was 15 'unresolved')", count("active") === 0, `${count("active")}`);
  check("nothing was mislabelled 'recovered'", count("recovered") === 0);
  check("no row is customer-actionable",
    REAL.every((r) => classifySyncIssue(r).customerActionable === false));
}

// ── 6. Safety rules ─────────────────────────────────────────────────────────
console.log("6. Safety — what may and may not auto-recover");
{
  // Only Phase 1 rows carry cursorBlocking, and only they may auto-resolve.
  const phase1 = { kind: "UPSERT_ERROR", detail: { stage: "transaction-persist", runId: "r", cursorBlocking: true } };
  const legacy = { kind: "UPSERT_ERROR", detail: { merchant: "X", amount: 10 } }; // pre-Phase-1: no stage, no flag

  check("Phase 1 row is cursor-blocking", classifySyncIssue(phase1).cursorBlocking === true);
  check("pre-Phase-1 row is NOT cursor-blocking (never auto-resolves)",
    classifySyncIssue(legacy).cursorBlocking === false);
  check("pre-Phase-1 row is still treated as CRITICAL transaction loss (fail-loud default)",
    classifySyncIssue(legacy).severity === "critical" && classifySyncIssue(legacy).domain === "transactions");
  check("a legacy row NAMING a transaction is customer-actionable",
    classifySyncIssue({ ...legacy, plaidTransactionId: "txn_old" }).customerActionable === true);

  // A recovered condition is historical, not active.
  check("resolved condition → recovered",
    syncIssueState(phase1, { referentExists: true, resolved: true }) === "recovered");
  check("recovered is not active",
    isActiveIncident(phase1, { referentExists: true, resolved: true }) === false);

  check("stageOf tolerates a malformed detail", stageOf({ kind: "X", detail: "not-an-object" }) === null);

  // The member activity route may NEVER load `detail` (its own source guard).
  // The scalar plaidTransactionId must therefore be sufficient on its own.
  const bankRow    = { kind: "UPSERT_ERROR", plaidTransactionId: "txn_abc" };
  const repairRow  = { kind: "UPSERT_ERROR", plaidTransactionId: null };
  check("detail-free: a row naming a bank transaction IS customer-actionable",
    classifySyncIssue(bankRow).customerActionable === true && classifySyncIssue(bankRow).domain === "transactions");
  check("detail-free: a repair row (no txn id) is NOT customer-actionable",
    classifySyncIssue(repairRow).customerActionable === false);
  // The asymmetry: still LOUD for the operator, QUIET for the member.
  check("...but it is still surfaced to operators as critical (fail loud)",
    classifySyncIssue(repairRow).severity === "critical");
  check("the structural signal outranks a mislabelled stage",
    classifySyncIssue({ kind: "UPSERT_ERROR", plaidTransactionId: "t1", detail: { stage: "opening-position-repair" } }).domain === "transactions");
  check("unknown kind fails loud, not silent",
    classifySyncIssue({ kind: "SOMETHING_NEW" }).domain === "unknown");
}

console.log(failures === 0
  ? "\n✅ sync-issue-semantics: all checks passed"
  : `\n❌ sync-issue-semantics: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
