/**
 * lib/plaid/execution-convergence.test.ts  (OPS-2D-1)
 *
 * Every refresh-equivalent execution leaves RefreshExecution evidence.
 *
 * Before this slice, five paths mutated provider-derived data with only a lock
 * and no execution record — including the OPERATOR resync, which meant the
 * OPS-2C Refresh workspace could not see operator activity at all. The gap was
 * invisible precisely because each path worked correctly in isolation; only a
 * census across paths revealed it.
 *
 * This ratchet asserts the convergence, and — just as importantly — asserts the
 * things that must NOT have changed with it: locks, cooldowns, age gates, error
 * propagation, and stage population. A converged envelope that homogenised the
 * workflows would be a worse outcome than the gap it closed.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Every path that performs a refresh-equivalent execution, and its identity. */
const CONVERGED = [
  { file: "app/api/plaid/refresh/route.ts", trigger: "MANUAL", profile: "FULL_REFRESH", pre: true },
  { file: "jobs/sync-banks.ts", trigger: "CRON", profile: "FULL_REFRESH", pre: true },
  { file: "app/api/plaid/investments/enable/route.ts", trigger: "MANUAL", profile: "FULL_REFRESH", pre: false },
  { file: "app/api/plaid/sync/route.ts", trigger: "MANUAL", profile: "TRANSACTIONS_ONLY", pre: false },
  { file: "app/api/platform/platform-ops/connections/[id]/resync/route.ts", trigger: "OPERATOR", profile: "TRANSACTIONS_ONLY", pre: false },
  { file: "app/api/plaid/resume-sync/route.ts", trigger: "RESUME", profile: "IMPORT_RECOVERY", pre: false },
] as const;

/** Paths that reach the authority through the shared webhook wrapper. */
const VIA_WRAPPER = [
  { file: "app/api/plaid/webhook/route.ts", trigger: "WEBHOOK" },
  { file: "app/api/plaid/exchange-token/route.ts", trigger: "RECONNECT" },
  { file: "jobs/resume-stale-imports.ts", trigger: "RESUME" },
] as const;

function main() {
  console.log("convergence · every refresh-equivalent path reaches the authority");
  {
    for (const p of CONVERGED) {
      const src = strip(p.file);
      check(`${p.file}: uses runFullRefresh`, /runFullRefresh[<(]/.test(src));
      check(`${p.file}: declares trigger ${p.trigger}`, new RegExp(`trigger:\\s*"${p.trigger}"`).test(src));
      check(`${p.file}: declares profile ${p.profile}`, new RegExp(`profile:\\s*"${p.profile}"`).test(src));
    }
    for (const p of VIA_WRAPPER) {
      const src = strip(p.file);
      check(`${p.file}: reaches the authority via syncPlaidItemFromWebhook`, /syncPlaidItemFromWebhook\(/.test(src));
      check(`${p.file}: passes trigger ${p.trigger}`, new RegExp(`"${p.trigger}"`).test(src));
    }
  }

  console.log("no bypass remains · direct sync calls are always wrapped");
  {
    // Any route calling the sync engine directly must now do so INSIDE a
    // runFullRefresh runner. The check is positional: the authority call must
    // appear before the engine call in the file.
    const ROUTES_USING_ENGINE = [
      "app/api/plaid/sync/route.ts",
      "app/api/plaid/resume-sync/route.ts",
      "app/api/platform/platform-ops/connections/[id]/resync/route.ts",
      "app/api/plaid/investments/enable/route.ts",
    ];
    for (const f of ROUTES_USING_ENGINE) {
      const src = strip(f);
      const authorityAt = src.indexOf("runFullRefresh");
      const engineAt = src.search(/withPlaidItemSyncLock\(/);
      check(
        `${f}: the lock+engine call sits INSIDE the execution envelope`,
        authorityAt >= 0 && engineAt > authorityAt,
      );
    }
  }

  console.log("workflows preserved · the envelope did not homogenise them");
  {
    const resync = strip("app/api/platform/platform-ops/connections/[id]/resync/route.ts");
    check("operator resync keeps its manual cooldown", /checkManualRefreshCooldown/.test(resync));
    check("operator resync keeps its 409 in-flight response", /"in-flight"/.test(resync) && /409/.test(resync));
    check("operator resync keeps its audit write", /CONNECTION_RESYNC_TRIGGERED/.test(resync));
    check("operator resync keeps health classification on failure", /classifyPlaidErrorForHealth/.test(resync));

    const sync = strip("app/api/plaid/sync/route.ts");
    check("/sync keeps its per-item cooldown partition", /checkManualRefreshCooldown/.test(sync) && /markManyManualRefreshed/.test(sync));
    check("/sync keeps per-item isolation (one failure never blocks siblings)", /catch\s*\(e\)/.test(sync) && /continue;/.test(sync));

    const resume = strip("app/api/plaid/resume-sync/route.ts");
    check("resume-sync keeps its AGE gate, not a cooldown", /RESUME_MIN_AGE_MS/.test(resume) && !/checkManualRefreshCooldown/.test(resume));
    check("resume-sync keeps its best-effort wealth regeneration", /regenerateWealthHistoryForItem/.test(resume));

    const enable = strip("app/api/plaid/investments/enable/route.ts");
    check("investments/enable still runs the FULL pipeline body", /refreshPlaidItem\(/.test(enable));
    check("investments/enable still deliberately bypasses the cooldown", !/checkManualRefreshCooldown/.test(enable));
    check("investments/enable keeps its per-user rate limit", /limitByUser/.test(enable));
  }

  console.log("stage population is truthful · runId still correlates");
  {
    // The three transactions-only paths must record a TRANSACTIONS stage and
    // must NOT claim balances/holdings/snapshot they never ran.
    for (const f of [
      "app/api/plaid/sync/route.ts",
      "app/api/plaid/resume-sync/route.ts",
      "app/api/platform/platform-ops/connections/[id]/resync/route.ts",
    ]) {
      const src = strip(f);
      check(`${f}: records a TRANSACTIONS stage`, /recorder\.begin\("TRANSACTIONS"/.test(src));
      check(`${f}: records IN_FLIGHT when the lock is held`, /recorder\.skip\("TRANSACTIONS",\s*"PROVIDER",\s*"IN_FLIGHT"\)/.test(src));
      check(`${f}: claims no BALANCES stage`, !/recorder\.(begin|succeed)\("BALANCES"/.test(src));
      check(`${f}: claims no HOLDINGS stage`, !/recorder\.(begin|succeed)\("HOLDINGS"/.test(src));
      check(`${f}: claims no SNAPSHOT stage`, !/recorder\.(begin|succeed)\("SNAPSHOT"/.test(src));
      check(`${f}: threads runId into the sync (SyncIssue correlation)`, /\{\s*runId\s*\}/.test(src));
    }
    // The full-pipeline path delegates staging to refreshPlaidItem itself.
    const enable = strip("app/api/plaid/investments/enable/route.ts");
    check("investments/enable delegates staging to refreshPlaidItem", /recorder,\s*runId/.test(enable));
    check("investments/enable declares no stages of its own", !/recorder\.(begin|succeed|skip)\(/.test(enable));
  }

  console.log("vocabulary · added only what the population required");
  {
    const types = strip("lib/plaid/refresh-execution-types.ts");
    for (const v of ["OPERATOR", "RESUME"]) {
      check(`trigger ${v} exists`, new RegExp(`\\|\\s*"${v}"`).test(types));
    }
    for (const v of ["TRANSACTIONS_ONLY", "IMPORT_RECOVERY"]) {
      check(`profile ${v} exists`, new RegExp(`\\|\\s*"${v}"`).test(types));
    }
    check("no speculative trigger was added", !/"RECOVERY"|"MIGRATION"|"PROVIDER_RETRY"|"IMPORT"/.test(types));
    check("no tier/LIGHT profiles were added", !/"LIGHT"|"REALTIME"|"TIER/.test(types));
  }

  console.log("scope · no policy, admission, capability, or control entered");
  {
    const touched = [
      "lib/plaid/refresh-execution-types.ts",
      "lib/plaid/webhook-sync.ts",
      "jobs/resume-stale-imports.ts",
      ...CONVERGED.filter((c) => !c.pre).map((c) => c.file),
    ];
    const forbidden = /mayRun|admission|JobControlState|JobAdmissionPolicy|maintenanceMode|pausedUntil|declaredPolicy|CONTROL/;
    for (const f of touched) {
      check(`${f}: no OPS-2D policy/admission/capability vocabulary`, !forbidden.test(strip(f)));
    }
    // The legacy /api/jobs/* bypass is explicitly NOT closed in this slice.
    for (const f of ["app/api/jobs/sync-banks/route.ts", "app/api/jobs/process-deletions/route.ts"]) {
      check(`${f}: untouched (bypass closure is later OPS-2D work)`, !/runFullRefresh|admission/.test(strip(f)));
    }
    // itemRemove / provider lifecycle stays outside the refresh envelope.
    for (const c of CONVERGED.filter((x) => !x.pre)) {
      check(`${c.file}: does not take over provider lifecycle`, !/itemRemove/.test(strip(c.file)));
    }
  }

  console.log("one ledger · no second execution record was introduced");
  {
    for (const c of CONVERGED.filter((x) => !x.pre)) {
      const src = strip(c.file);
      check(
        `${c.file}: writes no route-local execution record`,
        !/\.(refreshExecution|refreshEndpointResult|providerCall|refreshEndpointAccountCoverage)\s*\./.test(src),
      );
    }
  }

  if (failures > 0) {
    console.error(`\nexecution-convergence.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nexecution-convergence.test: all passed.");
}

main();
