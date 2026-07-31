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
    // V26 OPS-REFRESH-1A — THIS CENSUS ONCE PASSED OVER A REAL GAP.
    //
    // `app/api/plaid/refresh/route.ts` forks on `body.plaidItemId`. The
    // single-item branch has used runFullRefresh since DF-2A, so the token check
    // below was satisfied — while the all-items branch (the topbar Refresh
    // button, the product's primary refresh gesture) called refreshPlaidItem
    // through refreshAllActiveItemsForUser, in a DIFFERENT FILE this list never
    // read, with no recorder, no runId and no execution row at all.
    //
    // The lesson is not "add another file to the list". A `runFullRefresh`
    // appearing in a file proves a call site exists; it cannot prove that EVERY
    // branch reaches it. The intent — "every per-item refresh performed by the
    // fan-out executes through the envelope" — is asserted BEHAVIOURALLY in
    // lib/plaid/refresh-fanout.test.ts, which runs the real service over
    // injected collaborators and fails if the envelope is missing OR bypassed.
    // The pointer below keeps that guard discoverable from here; it does not
    // pretend to be the guard itself.
    check(
      "the all-items fan-out's convergence is asserted behaviourally (see refresh-fanout.test.ts)",
      /runManualItemRefresh/.test(strip("lib/plaid/refresh.ts"))
        && /refreshAllActiveItemsForUser/.test(strip("lib/plaid/refresh-fanout.test.ts")),
    );

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

  console.log("scope · producers consume policy, they never implement it");
  {
    const touched = [
      "lib/plaid/refresh-execution-types.ts",
      "lib/plaid/webhook-sync.ts",
      "jobs/resume-stale-imports.ts",
      ...CONVERGED.filter((c) => !c.pre).map((c) => c.file),
    ];
    // NARROWED IN OPS-2D-3 (was: a lexical ban on the word "admission" and
    // friends). That fence was written to hold OPS-2D-1's scope, and it did —
    // but its regex was broader than the rule it stood for, so the slice it was
    // fencing FOR could not cross it. The enduring rule is not "these files must
    // never mention admission"; it is "these files must never BE the policy
    // authority". A producer calling the canonical evaluator is convergence
    // working; a producer reading settings and deciding for itself is the
    // duplication OPS-2D-1 existed to end.
    //
    // (Fifth time a guard has been broader than its own doctrine. The habit that
    // keeps catching it: state the intent in the assertion, not a proxy for it.)
    const IMPLEMENTS_POLICY = [
      { re: /platformSetting\.|PlatformSettingKey/,        what: "reads control-plane settings directly" },
      { re: /"(MAINTENANCE_MODE|INGESTION_PAUSED|CONTROL_PLANE_[A-Z_]+)"/, what: "hardcodes an admission reason code" },
      { re: /ADMISSION_REASONS|evaluateAdmission|readFactState/, what: "evaluates admission itself" },
      { re: /mayRun|JobControlState|JobAdmissionPolicy|declaredPolicy|pausedUntil/, what: "invents its own control-plane model" },
      { re: /hasPlatformAccess|LEVEL_RANK|ISSUABLE_LEVELS|PlatformAccessLevel/, what: "reimplements authorization" },
    ];
    for (const f of touched) {
      const src = strip(f);
      for (const rule of IMPLEMENTS_POLICY) {
        check(`${f}: never ${rule.what}`, !rule.re.test(src));
      }
    }
    // OPS-2D-3 pinned this at exactly one (the representative path). OPS-2D-4
    // converged the rest, so the assertion tightens rather than loosens: EVERY
    // producer in this set now consumes the evaluator, and the one file that
    // does not is the type module, which has nothing to admit.
    //
    // Stated as "every producer" rather than a magic number so it keeps holding
    // as the converged set grows — a new producer added to CONVERGED without
    // admission fails here immediately. Placement, evidence and channel
    // semantics live in lib/platform/admission/producer-convergence.test.ts.
    const TYPES_ONLY = "lib/plaid/refresh-execution-types.ts";
    for (const f of touched) {
      const consumes = /admitOperationalWork\(/.test(strip(f));
      if (f === TYPES_ONLY) {
        check(`${f}: a vocabulary module admits nothing`, !consumes);
      } else {
        check(`${f}: consumes the canonical evaluator (OPS-2D-4)`, consumes);
      }
    }

    // The legacy /api/jobs/* bypass is explicitly NOT closed in this slice.
    for (const f of ["app/api/jobs/sync-banks/route.ts", "app/api/jobs/process-deletions/route.ts"]) {
      check(`${f}: untouched (bypass closure is later OPS-2D work)`, !/runFullRefresh|admitOperationalWork/.test(strip(f)));
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
