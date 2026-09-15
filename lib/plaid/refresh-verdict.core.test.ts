/**
 * lib/plaid/refresh-verdict.core.test.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * The verdict is DERIVED at the completion write, so every branch of the
 * derivation is pinned here, with no database and no clock:
 *   · a typed code wins over the message; a message decides only when no code did;
 *   · "This operation was aborted" — the real BTC failure — is a PROVIDER_TIMEOUT;
 *   · the outcome is proven by counts, never assumed: a FAILED stage proves
 *     nothing, and no counts at all leaves the outcome absent (unknown ≠ unchanged);
 *   · the producer's override wins only for the fields it sets, and failure
 *     fields never appear on a successful execution.
 */

import {
  buildVerdict,
  classifyFailureCategory,
  deriveOutcome,
  firstFailedStage,
} from "./refresh-verdict.core";
import type { RefreshStageRecord } from "./refresh-execution-types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const at = new Date("2026-09-15T16:35:00.000Z");
function stage(over: Partial<RefreshStageRecord>): RefreshStageRecord {
  return {
    endpoint: "WALLET_SYNC", stageKind: "PROVIDER", status: "SUCCEEDED",
    startedAt: at, completedAt: at, durationMs: 100, coveredAccountIds: [], accounts: [],
    ...over,
  };
}

console.log("classifyFailureCategory · typed codes");
{
  check("wallet PROVIDER_NOT_CONFIGURED → CONFIGURATION", classifyFailureCategory({ code: "PROVIDER_NOT_CONFIGURED" }) === "CONFIGURATION");
  check("wallet INVALID_WALLET_ADDRESS → INPUT", classifyFailureCategory({ code: "INVALID_WALLET_ADDRESS" }) === "INPUT");
  check("wallet CHAIN_UNSUPPORTED → UNSUPPORTED", classifyFailureCategory({ code: "CHAIN_UNSUPPORTED" }) === "UNSUPPORTED");
  check("wallet ADAPTER_ERROR → INTERNAL", classifyFailureCategory({ code: "ADAPTER_ERROR" }) === "INTERNAL");
  check("Plaid RATE_LIMIT_EXCEEDED → PROVIDER_RATE_LIMITED", classifyFailureCategory({ code: "RATE_LIMIT_EXCEEDED" }) === "PROVIDER_RATE_LIMITED");
  check("Plaid ITEM_LOGIN_REQUIRED → PROVIDER_AUTH", classifyFailureCategory({ code: "ITEM_LOGIN_REQUIRED" }) === "PROVIDER_AUTH");
  check("a code that already IS a category passes through", classifyFailureCategory({ code: "PROVIDER_TIMEOUT" }) === "PROVIDER_TIMEOUT");
  check("an unknown code falls through to the message", classifyFailureCategory({ code: "SOMETHING_NEW", message: "request timed out" }) === "PROVIDER_TIMEOUT");
}

console.log("classifyFailureCategory · messages");
{
  check("the real BTC failure: 'This operation was aborted' → PROVIDER_TIMEOUT",
    classifyFailureCategory({ message: "This operation was aborted" }) === "PROVIDER_TIMEOUT");
  check("SOL 'network error: This operation was aborted' → PROVIDER_TIMEOUT (timeout outranks network)",
    classifyFailureCategory({ message: "network error: This operation was aborted" }) === "PROVIDER_TIMEOUT");
  check("BALANCE_UNAVAILABLE is COARSE: an aborted message refines it to PROVIDER_TIMEOUT",
    classifyFailureCategory({ code: "BALANCE_UNAVAILABLE", message: "This operation was aborted" }) === "PROVIDER_TIMEOUT");
  check("the real sweep failure: BALANCE_UNAVAILABLE + 'mempool.space did not respond within 10000 ms' → PROVIDER_TIMEOUT",
    classifyFailureCategory({ code: "BALANCE_UNAVAILABLE", message: "mempool.space did not respond within 10000 ms" }) === "PROVIDER_TIMEOUT");
  check("BALANCE_UNAVAILABLE with an unrecognised message falls back to the code's PROVIDER_ERROR",
    classifyFailureCategory({ code: "BALANCE_UNAVAILABLE", message: "no canonical BTC close in the price archive on or before 2026-09-15" }) === "PROVIDER_ERROR");
  check("a PRECISE code is never overridden by its message",
    classifyFailureCategory({ code: "PROVIDER_NOT_CONFIGURED", message: "request timed out" }) === "CONFIGURATION");
  check("'429 Too Many Requests' → PROVIDER_RATE_LIMITED", classifyFailureCategory({ message: "429 Too Many Requests" }) === "PROVIDER_RATE_LIMITED");
  check("'No Solana RPC endpoint is configured' → CONFIGURATION",
    classifyFailureCategory({ message: "No Solana RPC endpoint is configured on this deployment, so this wallet's balance cannot be read." }) === "CONFIGURATION");
  check("'ECONNRESET' → PROVIDER_ERROR", classifyFailureCategory({ message: "read ECONNRESET" }) === "PROVIDER_ERROR");
  check("'Bad Gateway' → PROVIDER_ERROR", classifyFailureCategory({ message: "502 Bad Gateway" }) === "PROVIDER_ERROR");
  check("nothing recognisable → UNKNOWN", classifyFailureCategory({ message: "wat" }) === "UNKNOWN");
  check("no evidence at all → UNKNOWN", classifyFailureCategory({}) === "UNKNOWN");
}

console.log("deriveOutcome · proven by counts");
{
  check("no counts anywhere → undefined (unknown, never unchanged)",
    deriveOutcome([stage({})]) === undefined);
  check("a SUCCEEDED stage with 0 written and 0 changed → NO_CHANGE",
    deriveOutcome([stage({ endpoint: "HISTORY_BACKFILL", stageKind: "DERIVED", recordsWritten: 0, recordsChanged: 0 })]) === "NO_CHANGE");
  check("a SUCCEEDED stage with rows written → UPDATED",
    deriveOutcome([stage({ recordsWritten: 12 })]) === "UPDATED");
  check("changed > 0 with written 0 still → UPDATED",
    deriveOutcome([stage({ recordsWritten: 0, recordsChanged: 3 })]) === "UPDATED");
  check("a FAILED stage's counts prove nothing",
    deriveOutcome([stage({ status: "FAILED", recordsWritten: 5 })]) === undefined);
  check("one stage with counts and one without: the counted stage decides",
    deriveOutcome([stage({}), stage({ endpoint: "HISTORY_BACKFILL", recordsWritten: 0, recordsChanged: 0 })]) === "NO_CHANGE");
  check("a SKIPPED stage is ignored", deriveOutcome([stage({ status: "SKIPPED" })]) === undefined);
}

console.log("firstFailedStage");
{
  check("none failed → undefined", firstFailedStage([stage({})]) === undefined);
  check("the first FAILED stage's endpoint",
    firstFailedStage([stage({}), stage({ endpoint: "HISTORY_BACKFILL", status: "FAILED" })]) === "HISTORY_BACKFILL");
}

console.log("buildVerdict · composition");
{
  const failed = [stage({ status: "FAILED", errorSummary: "This operation was aborted" })];
  const v = buildVerdict({ stages: failed, failed: true });
  check("failed, no override: stage from the ledger, category from the stage's message",
    v.failureStage === "WALLET_SYNC" && v.failureCategory === "PROVIDER_TIMEOUT", JSON.stringify(v));
  check("failed, no counts: no outcome", v.outcome === undefined);

  const withOverride = buildVerdict({
    stages: failed, failed: true,
    override: { failureStage: "price", failureCategory: "PROVIDER_ERROR" },
  });
  check("the producer's stage name and category override the derivation",
    withOverride.failureStage === "price" && withOverride.failureCategory === "PROVIDER_ERROR");

  const partial = buildVerdict({ stages: failed, failed: true, override: { failureStage: "balance" } });
  check("an override sets only what it names; the rest stays derived",
    partial.failureStage === "balance" && partial.failureCategory === "PROVIDER_TIMEOUT");

  const thrown = buildVerdict({ stages: failed, failed: true, error: { message: "429 Too Many Requests", code: null } });
  check("a thrown error's evidence outranks the stage's message",
    thrown.failureCategory === "PROVIDER_RATE_LIMITED");

  const ok = buildVerdict({
    stages: [stage({}), stage({ endpoint: "HISTORY_BACKFILL", stageKind: "DERIVED", recordsWritten: 0, recordsChanged: 0 })],
    failed: false,
    override: { failureStage: "price", failureCategory: "INTERNAL" },
  });
  check("a SUCCEEDED execution never carries failure fields, even if a producer offers them",
    ok.failureStage === undefined && ok.failureCategory === undefined);
  check("…and its outcome is the proven NO_CHANGE", ok.outcome === "NO_CHANGE");

  const forced = buildVerdict({ stages: [stage({})], failed: false, override: { outcome: "UPDATED" } });
  check("a producer may assert an outcome it proved itself", forced.outcome === "UPDATED");
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
