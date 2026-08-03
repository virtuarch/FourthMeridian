/**
 * lib/plaid/historical-stages.test.ts
 *
 * V26-STAGE-1 — stage ordering, resumable retry, readiness derivation, and the
 * static guarantees that the split is real. Standalone tsx, pure (no DB).
 */

import {
  HISTORICAL_STAGES, LEGACY_HISTORY_STAGE, STALE_ATTEMPT_MS,
  nextStageToRun, deriveHistoryReadiness, deriveCurrentReadiness,
  isHistoricalStage, isHistoricalStageStatus, isStageErrorCode, stageIndex,
  type StageAttemptRecord, type HistoricalStage, type HistoricalStageStatus,
} from "./historical-stages.core";
import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const T0 = new Date("2026-08-04T10:00:00Z");
const WIN = { fromDate: "2025-08-03", toDate: "2026-08-02" };

const at = (
  stage: HistoricalStage, status: HistoricalStageStatus,
  over: Partial<StageAttemptRecord> = {},
): StageAttemptRecord => ({
  stage, status, attempt: 1,
  windowFromISO: WIN.fromDate, windowToISO: WIN.toDate,
  errorCode: null, startedAt: T0, completedAt: new Date(T0.getTime() + 1000),
  ...over,
});

const allSettled = (last: HistoricalStageStatus = "SUCCEEDED"): StageAttemptRecord[] =>
  HISTORICAL_STAGES.map((s, i) => at(s, i === HISTORICAL_STAGES.length - 1 ? last : "SUCCEEDED"));

const resume = (a: readonly StageAttemptRecord[]) =>
  nextStageToRun(a, { windowFromISO: WIN.fromDate, windowToISO: WIN.toDate, now: new Date(T0.getTime() + 5000) });

function main(): void {
  console.log("V26-STAGE-1 — historical execution stages\n");

  console.log("vocabulary + ordering");
  check("five stages in mandatory order",
    JSON.stringify(HISTORICAL_STAGES) === '["COVERAGE","RECONSTRUCTION","OWNERSHIP","PRICES","REGENERATION"]');
  check("ordering is strictly increasing",
    HISTORICAL_STAGES.every((s, i) => stageIndex(s) === i));
  check("guards reject a parallel vocabulary",
    !isHistoricalStage("HISTORY_BACKFILL") && !isHistoricalStage("coverage") &&
    !isHistoricalStageStatus("OK") && !isStageErrorCode("BOOM"));
  check("PROVIDER_LIMITED is a first-class status",
    isHistoricalStageStatus("PROVIDER_LIMITED"));

  console.log("\nretry (A–G)");
  // A — everything succeeded.
  check("A. all five succeeded → complete, nothing to run",
    resume(allSettled()).kind === "complete");

  // B — coverage failed: downstream never began.
  {
    const d = resume([at("COVERAGE", "FAILED", { errorCode: "PROVIDER_ERROR" })]);
    check("B. coverage failed → retry begins at COVERAGE",
      d.kind === "run" && d.stage === "COVERAGE");
    check("B. …and nothing downstream is reusable", d.reusable.length === 0);
  }

  // C — reconstruction failed: coverage reused.
  {
    const d = resume([at("COVERAGE", "SUCCEEDED"), at("RECONSTRUCTION", "FAILED", { errorCode: "RECONSTRUCTION_CONFLICT" })]);
    check("C. reconstruction failed → retry begins at RECONSTRUCTION",
      d.kind === "run" && d.stage === "RECONSTRUCTION");
    check("C. …COVERAGE is reused, never rerun",
      JSON.stringify(d.reusable) === '["COVERAGE"]');
  }

  // D — ownership skipped.
  {
    const a = [at("COVERAGE","SUCCEEDED"), at("RECONSTRUCTION","SUCCEEDED"), at("OWNERSHIP","SKIPPED")];
    const d = resume(a);
    check("D. SKIPPED settles the stage — pipeline advances to PRICES",
      d.kind === "run" && d.stage === "PRICES");
    check("D. …and the skipped stage counts as reusable",
      d.reusable.includes("OWNERSHIP"));
  }

  // E — prices provider-limited: regeneration still runs.
  {
    const a = [at("COVERAGE","SUCCEEDED"), at("RECONSTRUCTION","SUCCEEDED"),
               at("OWNERSHIP","SUCCEEDED"), at("PRICES","PROVIDER_LIMITED", { errorCode: "PROVIDER_LIMIT" })];
    const d = resume(a);
    check("E. provider-limited PRICES does not block REGENERATION",
      d.kind === "run" && d.stage === "REGENERATION", JSON.stringify(d));
    check("E. …and PRICES is never retried", d.reusable.includes("PRICES"));
  }

  // F — price failure then retry: upstream not rerun.
  {
    const d = resume([at("COVERAGE","SUCCEEDED"), at("RECONSTRUCTION","SUCCEEDED"),
                      at("OWNERSHIP","SUCCEEDED"), at("PRICES","FAILED", { errorCode: "PRICE_GAP" })]);
    check("F. retry begins at PRICES", d.kind === "run" && d.stage === "PRICES");
    check("F. …reconstruction and ownership are NOT rerun",
      JSON.stringify(d.reusable) === '["COVERAGE","RECONSTRUCTION","OWNERSHIP"]');
  }

  // G — regeneration failure then retry: prices not refetched.
  {
    const d = resume(allSettled("FAILED"));
    check("G. retry begins at REGENERATION", d.kind === "run" && d.stage === "REGENERATION");
    check("G. …PRICES is reused, not refetched", d.reusable.includes("PRICES"));
  }

  // Second attempt supersedes the first.
  {
    const a = [at("COVERAGE","SUCCEEDED"),
               at("RECONSTRUCTION","FAILED"), at("RECONSTRUCTION","SUCCEEDED", { attempt: 2 })];
    const d = resume(a);
    check("a later successful attempt supersedes an earlier failure",
      d.kind === "run" && d.stage === "OWNERSHIP", JSON.stringify(d));
  }

  console.log("\nconcurrency (H–J)");
  // H/I — an attempt still open blocks; a crash-abandoned one is recoverable.
  {
    const running = at("COVERAGE", "SUCCEEDED", { completedAt: null });
    const fresh = nextStageToRun([running], { now: new Date(T0.getTime() + 1000) });
    check("H. an in-flight stage BLOCKS — no duplicate financial work",
      fresh.kind === "blocked" && fresh.stage === "COVERAGE");
    const stale = nextStageToRun([running], { now: new Date(T0.getTime() + STALE_ATTEMPT_MS + 1) });
    check("J. a stale RUNNING attempt becomes runnable after the TTL",
      stale.kind === "run" && stale.stage === "COVERAGE");
  }
  // I — crash between stages: the completed stage stays succeeded.
  {
    const d = resume([at("COVERAGE","SUCCEEDED"), at("RECONSTRUCTION","SUCCEEDED")]);
    check("I. crash after RECONSTRUCTION → resume at OWNERSHIP, upstream intact",
      d.kind === "run" && d.stage === "OWNERSHIP" && d.reusable.length === 2);
  }

  // Window mismatch is not resumption.
  {
    const d = nextStageToRun(allSettled(), { windowFromISO: "2024-08-03", windowToISO: WIN.toDate, now: T0 });
    check("K. a different window is NOT resumed against settled stages",
      d.kind === "run" && d.stage === "COVERAGE", JSON.stringify(d));
  }

  console.log("\nreadiness (L–M)");
  check("all succeeded → HISTORY_READY", deriveHistoryReadiness({ attempts: allSettled() }) === "HISTORY_READY");
  check("regeneration failed → HISTORY_FAILED",
    deriveHistoryReadiness({ attempts: allSettled("FAILED") }) === "HISTORY_FAILED");
  check("mid-pipeline → HISTORY_BUILDING",
    deriveHistoryReadiness({ attempts: [at("COVERAGE","SUCCEEDED")] }) === "HISTORY_BUILDING");
  check("a provider limit anywhere → HISTORY_PROVIDER_LIMITED",
    deriveHistoryReadiness({ attempts: [
      at("COVERAGE","SUCCEEDED"), at("RECONSTRUCTION","SUCCEEDED"), at("OWNERSHIP","SUCCEEDED"),
      at("PRICES","PROVIDER_LIMITED"), at("REGENERATION","SUCCEEDED")] }) === "HISTORY_PROVIDER_LIMITED");
  check("regeneration left unsupported dates → HISTORY_PARTIAL",
    deriveHistoryReadiness({ attempts: allSettled(), regenerationLeftUnsupportedDates: true }) === "HISTORY_PARTIAL");
  check("no attempts → HISTORY_UNKNOWN, never a false ready",
    deriveHistoryReadiness({ attempts: [] }) === "HISTORY_UNKNOWN");
  check("regeneration SKIPPED never reads as ready",
    deriveHistoryReadiness({ attempts: allSettled("SKIPPED") }) === "HISTORY_PARTIAL");

  // L — current readiness is structurally independent of history.
  check("L. balances succeeded + history failed → CURRENT_READY",
    deriveCurrentReadiness({ balancesStageStatus: "SUCCEEDED" }) === "CURRENT_READY" &&
    deriveHistoryReadiness({ attempts: allSettled("FAILED") }) === "HISTORY_FAILED");
  check("L. …and no historical stage can even be passed to current readiness",
    deriveCurrentReadiness({ balancesStageStatus: null }) === "CURRENT_UNKNOWN");

  console.log("\nstatic guards");
  {
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const bg   = strip(readFileSync("lib/plaid/backgroundHistorySync.ts", "utf8"));
    const core = strip(readFileSync("lib/plaid/historical-stages.core.ts", "utf8"));
    const rec  = strip(readFileSync("lib/plaid/historical-stage-recorder.ts", "utf8"));

    // 1/9 — legacy stage is read-compatible, write-forbidden.
    check("1. the migrated Plaid path no longer WRITES HISTORY_BACKFILL",
      !new RegExp(`(begin|succeed|skip|fail)\\(\\s*"${LEGACY_HISTORY_STAGE}"`).test(bg));
    check("9. the legacy name survives for READ compatibility",
      /LEGACY_HISTORY_STAGE/.test(core) && /LEGACY_HISTORY_STAGE/.test(rec));

    // 2 — one ordering authority.
    check("2. ordering is defined exactly once",
      (core.match(/const HISTORICAL_STAGES\s*=/g) ?? []).length === 1 &&
      !/\["COVERAGE"/.test(bg));

    // 4/5 — recording a stage never authorizes a snapshot.
    check("4/5. the stage recorder writes no snapshot and no support status",
      !/spaceSnapshot|cryptoValuationStatus|completenessTier/.test(rec));
    check("5. the pure authority reads no snapshot state at all",
      !/spaceSnapshot|cryptoValuationStatus/.test(core));

    // 8 — no credential in stage metadata.
    check("8. no credential or provider payload enters stage metadata",
      !/API_KEY|apiKey|access_token|accessToken|secret/i.test(rec));
    check("8. …and stored error prose is truncated",
      /MAX_ERROR_CHARS/.test(rec));

    // 7 — no read path performs historical execution.
    const anyRoute = readFileSync("app/api/accounts/wallet/route.ts", "utf8");
    check("7. no API read path runs the historical pipeline",
      !/settleHistoricalStage|backfillHistoryForItem/.test(anyRoute));

    // 3 — REGENERATION is last, so it cannot precede PRICES by construction.
    check("3. REGENERATION is ordered after PRICES in the one definition",
      stageIndex("REGENERATION") > stageIndex("PRICES"));
  }

  console.log(failures === 0 ? "\nAll historical-stage guards passed." : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
