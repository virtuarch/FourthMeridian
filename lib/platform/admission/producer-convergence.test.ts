/**
 * lib/platform/admission/producer-convergence.test.ts  (OPS-2D-4)
 *
 * Every operational producer asks the same authority the same question, in the
 * same place, and translates the same answer into its own channel's contract.
 *
 * OPS-2D-3 proved the authority works on one path. The risk in adopting it
 * across seven more is not that someone forgets to call it — that is visible.
 * The risk is that adoption is *shallow*: the call is added but placed after the
 * cooldown is consumed, or after the lock is claimed, or a producer quietly
 * reconstructs the decision, or a fan-out re-resolves platform facts per item so
 * one dispatch can behave two ways. Each of those passes a naive "does it import
 * the helper" check and defeats the point.
 *
 * So the assertions here are about ORDER, PLACEMENT, EVIDENCE and OWNERSHIP —
 * not about imports.
 *
 * Run:  npx tsx lib/platform/admission/producer-convergence.test.ts
 */

import { readFileSync, statSync } from "node:fs";
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

/** Source with comments AND imports stripped — so every position is a CALL SITE. */
function body(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^import[\s\S]*?;$/gm, "");
}
/** Source with comments stripped but imports kept. */
function code(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}
const exists = (rel: string) => { try { statSync(path.join(ROOT, rel)); return true; } catch { return false; } };
const at = (s: string, re: RegExp) => { const m = re.exec(s); return m ? m.index : -1; };

/**
 * THE CLOSED CENSUS. Eight producers of refresh-equivalent work, plus the one
 * discovered during OPS-2D-4's closure sweep and deliberately left out of scope.
 *
 * `channel` drives which outcome contract is asserted:
 *   http   — an interactive request; must answer 503 with the typed reason
 *   job    — a scheduled fan-out; must return normally with a dispatch finding
 *   shared — the wrapper used by webhook / connect / recovery
 */
const PRODUCERS = [
  { file: "app/api/platform/platform-ops/connections/[id]/resync/route.ts",
    channel: "http", migrated: true, fanout: false, slice: "OPS-2D-3" },
  { file: "app/api/plaid/refresh/route.ts",
    channel: "http", migrated: true, fanout: true,  slice: "OPS-2D-4" },
  { file: "app/api/plaid/sync/route.ts",
    channel: "http", migrated: true, fanout: true,  slice: "OPS-2D-4" },
  { file: "app/api/plaid/resume-sync/route.ts",
    channel: "http", migrated: true, fanout: false, slice: "OPS-2D-4" },
  { file: "app/api/plaid/investments/enable/route.ts",
    channel: "http", migrated: true, fanout: false, slice: "OPS-2D-4" },
  { file: "jobs/sync-banks.ts",
    channel: "job", migrated: true, fanout: true,  slice: "OPS-2D-4" },
  { file: "jobs/resume-stale-imports.ts",
    channel: "job", migrated: true, fanout: true,  slice: "OPS-2D-4" },
  { file: "lib/plaid/webhook-sync.ts",
    channel: "shared", migrated: true, fanout: false, slice: "OPS-2D-4" },
] as const;

/**
 * Producers deliberately NOT migrated.
 *
 * EMPTY as of OPS-2D-4A. It previously held lib/plaid/exchangeToken.ts, the
 * eighth producer found by sweeping every direct caller of the sync engine
 * during OPS-2D-4's census-closure step. It was left out of D4 because it does
 * connection establishment AND initial ingestion in one function, and a single
 * gate around it would have been wrong in both directions at once. OPS-2D-4A
 * split the stages; it now declares both work classes and appears in the
 * boundary census with the rest.
 *
 * Kept as an empty, asserted list rather than deleted: the next producer that
 * cannot be migrated immediately needs somewhere honest to sit, and an empty
 * list that is still checked is what makes "nothing is deferred" a claim rather
 * than an absence.
 */
const OUT_OF_SCOPE: readonly { file: string; why: string }[] = [];

/** Known legacy bypasses — separate from the census, and still bypasses. */
const LEGACY_BYPASSES = [
  "app/api/jobs/sync-banks/route.ts",
  "app/api/jobs/process-deletions/route.ts",
  "app/api/jobs/fetch-fx-rates/route.ts",
  "app/api/jobs/dispatch/route.ts",
] as const;

function main() {
  // ── 1. Every producer consumes the ONE authority ────────────────────────────
  console.log("1. one authority, consumed by every producer");
  {
    for (const p of PRODUCERS) {
      check(`${p.file}: exists`, exists(p.file));
      if (!exists(p.file)) continue;
      const src = code(p.file);
      check(`${p.file}: consumes admitOperationalWork [${p.slice}]`, /admitOperationalWork\(/.test(src));
      check(`${p.file}: asks for the canonical work class`,
        /admitOperationalWork\(\s*\{\s*work:\s*"REFRESH_EXECUTION"\s*\}/.test(src) ||
        // the shared wrapper may receive an already-taken verdict instead
        (p.channel === "shared" && /admission\s*\?\?\s*\(await admitOperationalWork/.test(src)));
    }
    check(`the census holds exactly 8 producers (got ${PRODUCERS.length})`, PRODUCERS.length === 8);
    check("all 8 are migrated", PRODUCERS.every((p) => p.migrated));
  }

  // ── 2. Placement: admission cannot be reached late ──────────────────────────
  console.log("2. admission is asked BEFORE anything is spent");
  {
    // Markers are optional per producer (not every route has a cooldown), so
    // each comparison is conditional — which means a marker RENAME silently
    // blinds this section rather than failing it. The floor below is the
    // tripwire: if the total number of ordering comparisons actually made drops,
    // the guard has gone blind and must be re-pointed, not trusted.
    let ordered = 0;
    for (const p of PRODUCERS) {
      if (!exists(p.file)) continue;
      const s = body(p.file);
      const adm  = at(s, /admitOperationalWork\(/);
      const auth = at(s, /await require(Fresh)?(User|PlatformAccess)\(/);
      const cd   = at(s, /await mark(Many)?ManualRefreshed\(/);
      const lock = at(s, /(withPlaidItemSyncLock|claimPlaidItemSyncLock)\(/);
      const prov = at(s, /(runFullRefresh|refreshPlaidItem|syncTransactionsForItem|runDeferredHistorySync)\(/);
      const mut  = at(s, /db\.plaidItem\.update\(/);

      check(`${p.file}: admission is reached at all`, adm >= 0);
      if (adm < 0) continue;
      // Authorization first — an unauthorized caller must not learn platform state.
      if (auth >= 0) { ordered++; check(`${p.file}: authorization precedes admission`, auth < adm); }
      // …and everything expensive after.
      if (cd   >= 0) { ordered++; check(`${p.file}: admission precedes cooldown consumption`, adm < cd); }
      if (lock >= 0) { ordered++; check(`${p.file}: admission precedes the lock claim`, adm < lock); }
      if (prov >= 0) { ordered++; check(`${p.file}: admission precedes provider work`, adm < prov); }
      if (mut  >= 0) { ordered++; check(`${p.file}: admission precedes any item mutation`, adm < mut); }
    }
    check(`the ordering guard is not vacuous (${ordered} comparisons made)`, ordered >= 10);
  }

  // ── 3. Fan-out resolves ONCE ────────────────────────────────────────────────
  console.log("3. a fan-out asks once, not once per item");
  {
    for (const p of PRODUCERS.filter((x) => x.fanout)) {
      const s = body(p.file);
      const calls = (s.match(/admitOperationalWork\(/g) ?? []).length;
      check(`${p.file}: exactly one resolution per dispatch (got ${calls})`, calls === 1);
      // The resolution must sit OUTSIDE the loop that walks items.
      const adm = at(s, /admitOperationalWork\(/);
      const loop = at(s, /for \(const \w+ of (items|eligibleItems)\)/);
      if (loop >= 0) check(`${p.file}: resolved outside the item loop`, adm < loop);
    }
    // resume-stale-imports threads its verdict down rather than letting the
    // wrapper re-resolve per item.
    check("resume-stale-imports threads its verdict into the shared wrapper",
      /syncPlaidItemFromWebhook\([^)]*,\s*admission\)/.test(body("jobs/resume-stale-imports.ts")));
    check("the shared wrapper accepts a pre-taken verdict",
      /admission\?:\s*StampedAdmissionVerdict/.test(code("lib/plaid/webhook-sync.ts")));
  }

  // ── 4. Channel-appropriate denial ───────────────────────────────────────────
  console.log("4. each channel translates DENY into its own contract");
  {
    for (const p of PRODUCERS.filter((x) => x.channel === "http")) {
      const s = code(p.file);
      check(`${p.file}: answers 503, not 403`,
        /"not-admitted"[\s\S]{0,400}status:\s*503/.test(s));
      check(`${p.file}: carries the typed reason and human label`,
        /reason:\s*admission\.reason/.test(s) && /message:\s*admission\.label/.test(s));
    }
    for (const p of PRODUCERS.filter((x) => x.channel === "job")) {
      const s = code(p.file);
      check(`${p.file}: returns normally with a dispatch-level finding`,
        /notAdmitted:\s*admission\.reason!/.test(s));
      check(`${p.file}: does not throw on denial`,
        !/if \(admission\.decision === "DENY"\)[\s\S]{0,300}throw /.test(s));
    }
    const wrapper = code("lib/plaid/webhook-sync.ts");
    // A distinct outcome value, not a pinned union spelling — member order and
    // formatting belong to TypeScript, not to this guard.
    check("not-admitted is a distinct outcome, NOT collapsed into skipped-locked",
      /return "not-admitted";/.test(wrapper) && /"skipped-locked"/.test(wrapper));
  }

  // ── 5. Evidence, sized to the channel ───────────────────────────────────────
  console.log("5. denial leaves evidence — proportionate evidence");
  {
    // Per-item producers ledger a denied RefreshExecution.
    for (const f of [
      "app/api/platform/platform-ops/connections/[id]/resync/route.ts",
      "lib/plaid/webhook-sync.ts",
    ]) {
      check(`${f}: ledgers the denial as a RefreshExecution`, /recordAdmissionDenial\(/.test(code(f)));
    }
    // Fan-out jobs deliberately do NOT — one dispatch finding, not N rows.
    for (const f of ["jobs/sync-banks.ts", "jobs/resume-stale-imports.ts"]) {
      check(`${f}: does NOT write a denied execution per candidate`,
        !/recordAdmissionDenial\(/.test(code(f)));
    }
    // The operator-visible path also audits.
    check("the operator path audits the denial",
      /auditResync\("not-admitted"/.test(code("app/api/platform/platform-ops/connections/[id]/resync/route.ts")));

    // OWNER-FACING routes deliberately do NOT ledger a denial. Pinned as an
    // assertion rather than left as an omission, because the opposite choice is
    // defensible and someone will otherwise "fix" it silently.
    //
    // The requester receives the typed reason synchronously, so the intent is
    // answered, not lost. The two paths that DO ledger have a reason to: the
    // operator resync is an operator acting on customer infrastructure, where
    // every action carries an audit obligation by doctrine; and webhook-sync is
    // machine-driven with nobody to answer, so evidence is the only record.
    //
    // Disclosed gap: an operator cannot currently see how many CUSTOMERS hit a
    // pause. If that signal is wanted, it is a demand metric — not a reason to
    // turn the execution ledger into a request log.
    for (const f of [
      "app/api/plaid/refresh/route.ts",
      "app/api/plaid/sync/route.ts",
      "app/api/plaid/resume-sync/route.ts",
      "app/api/plaid/investments/enable/route.ts",
    ]) {
      check(`${f}: owner-facing denial answers the caller, does not ledger`,
        !/recordAdmissionDenial\(/.test(code(f)));
    }
  }

  // ── 5b. Scheduler health stays honest ───────────────────────────────────────
  //
  // "The scheduler ran and policy denied the work" and "the scheduler failed to
  // run" must never look alike. runJob records `failed` only when the body
  // THROWS, and lib/jobs/health.ts classifies from status and timing alone — so
  // a job that returns normally with a notAdmitted finding stays `healthy`, and
  // its reason rides along in the JobRun summary. That is honest: the job did
  // its job. Asserted here so a future "throw on denial" cannot quietly make an
  // operator's own pause register as a broken scheduler.
  console.log("5b. a policy denial does not make the scheduler look broken");
  {
    for (const f of ["jobs/sync-banks.ts", "jobs/resume-stale-imports.ts"]) {
      const s = body(f);
      const i = s.indexOf('admission.decision === "DENY"');
      const branch = i >= 0 ? s.slice(i, i + 700) : "";
      check(`${f}: the denial branch returns, never throws`,
        i >= 0 && /return \{/.test(branch) && !/throw /.test(branch));
      check(`${f}: the finding is part of the returned summary`, /notAdmitted:/.test(s));
    }
    // Fails CLOSED: if the classifier is renamed, the guard reports it rather
    // than passing vacuously against an empty string.
    const healthTail = code("lib/jobs/health.ts").split("export function classify")[1];
    check("job health classifies from status/timing, not from the summary",
      healthTail !== undefined && !/summary/.test(healthTail),
      healthTail === undefined ? "export function classify* not found in lib/jobs/health.ts — re-point this guard" : undefined);
  }

  // ── 6. A denial fabricates nothing ──────────────────────────────────────────
  console.log("6. denial claims no work that did not happen");
  {
    // resume-stale-imports must not re-stamp recovery markers on a denied pass:
    // the return sits before the loop, and the loop owns every marker write.
    const rs = body("jobs/resume-stale-imports.ts");
    const denyReturn = at(rs, /notAdmitted:\s*admission\.reason!/);
    const loop = at(rs, /for \(const item of items\)/);
    // Returning before the loop IS the fabrication guard: a pass that never
    // touches a candidate cannot count one. The old zero-count object pins
    // (attempted: 0, ran: 0, …) asserted the same thing via key order and
    // whitespace, and broke on formatting.
    check("resume-stale-imports returns before touching any candidate",
      denyReturn >= 0 && loop >= 0 && denyReturn < loop);

    // The denial ledger row carries no stages and no error.
    const led = code("lib/plaid/refresh-execution.ts");
    check("a denied execution records no endpoint stages",
      !/recordAdmissionDenial[\s\S]{0,900}refreshEndpointResult/.test(led));
    check("a denied execution sets admissionReason, never errorSummary",
      /admissionReason:\s*params\.admissionReason/.test(led) &&
      !/errorSummary:\s*params\.admissionReason/.test(led));
  }

  // ── 7. Provider health is not degraded by policy ────────────────────────────
  console.log("7. a policy denial is not a provider failure");
  {
    for (const p of PRODUCERS) {
      if (!exists(p.file)) continue;
      const s = body(p.file);
      const adm = at(s, /admitOperationalWork\(/);
      if (adm < 0) continue;
      // Everything that stamps provider/connection health must sit AFTER the
      // admission gate, so a denial can never reach it.
      for (const [label, re] of [
        ["item health",   /setPlaidItemHealth\(/],
        ["error classify",/classifyPlaidErrorForHealth\(/],
        ["sync issue",    /recordSyncIssue\(|syncIssue\.create\(/],
        ["owner notify",  /notifyItemSyncFailed\(/],
      ] as const) {
        const i = at(s, re);
        if (i >= 0) check(`${p.file}: ${label} is unreachable from a denial`, adm < i);
      }
    }
    // The denial paths themselves never touch health.
    for (const f of ["jobs/sync-banks.ts", "jobs/resume-stale-imports.ts"]) {
      const s = code(f);
      const deny = s.slice(s.indexOf('admission.decision === "DENY"'));
      const end  = deny.indexOf("\n  }");
      check(`${f}: the denial branch stamps no health`,
        !/setPlaidItemHealth|classifyPlaidErrorForHealth|notifyItemSyncFailed/.test(deny.slice(0, end > 0 ? end : 600)));
    }
  }

  // ── 8. Ownership — nobody reimplements policy ───────────────────────────────
  console.log("8. producers consume policy; they never own it");
  {
    for (const p of PRODUCERS) {
      if (!exists(p.file)) continue;
      const s = code(p.file);
      check(`${p.file}: writes no reason literal`,
        !/"(MAINTENANCE_MODE|INGESTION_PAUSED|CONTROL_PLANE_[A-Z_]+)"/.test(s));
      check(`${p.file}: constructs no verdict`, !/decision:\s*"(ADMIT|DENY)"/.test(s));
      check(`${p.file}: reads no control-plane setting`,
        !/"(maintenance_mode|ingestion_paused)"/.test(s) &&
        !/PlatformSettingKey\.(MAINTENANCE_MODE|INGESTION_PAUSED)/.test(s));
      check(`${p.file}: evaluates nothing itself`,
        !/evaluateAdmission\(|readFactState\(|resolveControlPlaneFacts\(/.test(s));
      // Neither SYSTEM_ADMIN nor a capability may be consulted to skip admission.
      check(`${p.file}: no role or capability short-circuits admission`,
        !/(SYSTEM_ADMIN|hasPlatformAccess|LEVEL_RANK)[\s\S]{0,160}admitOperationalWork/.test(s));
    }
  }

  // ── 9. Out-of-scope producer stays reported, not absorbed ───────────────────
  console.log("9. deferred producers are listed, and the list is empty");
  {
    for (const o of OUT_OF_SCOPE) {
      check(`${o.file}: exists`, exists(o.file));
      check(`${o.file}: still NOT migrated — ${o.why}`,
        !/admitOperationalWork\(/.test(code(o.file)));
    }
    check("no producer remains deferred (OPS-2D-4A closed the last one)", OUT_OF_SCOPE.length === 0);
    // …and the one it closed is genuinely converged.
    check("lib/plaid/exchangeToken.ts consumes the canonical evaluator",
      /admitOperationalWork\(/.test(code("lib/plaid/exchangeToken.ts")));
  }

  // ── 10. Legacy bypasses stay identified as bypasses ─────────────────────────
  console.log("10. legacy /api/jobs/* bypasses remain explicitly detected");
  {
    for (const f of LEGACY_BYPASSES) {
      if (!exists(f)) { check(`${f}: exists`, false); continue; }
      check(`${f}: still bypasses admission (known, not closed here)`,
        !/admitOperationalWork\(/.test(code(f)));
    }
    check(`exactly ${LEGACY_BYPASSES.length} legacy bypasses are tracked`, LEGACY_BYPASSES.length === 4);
  }

  // ── 11. Scope — D5/D6 not begun, other sessions untouched ───────────────────
  console.log("11. scope held");
  {
    for (const p of PRODUCERS) {
      if (!exists(p.file)) continue;
      const s = code(p.file);
      check(`${p.file}: no control mutation or override`,
        !/setMaintenanceMode|setIngestionPaused|admissionOverride|forceAdmit/.test(s));
    }
    // Design Lab / Growth files must not appear anywhere in this convergence.
    for (const f of PRODUCERS.map((p) => p.file)) {
      if (!exists(f)) continue;
      check(`${f}: imports no Growth/Design-Lab module`,
        !/GrowthStagePanel|FunnelStages|growth-funnel/.test(code(f)));
    }
  }

  if (failures > 0) {
    console.error(`\nproducer-convergence.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nproducer-convergence.test: all passed.");
}

main();
