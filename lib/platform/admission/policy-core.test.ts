/**
 * lib/platform/admission/policy-core.test.ts  (OPS-2D-3)
 *
 * The admission evaluator, exhaustively.
 *
 * "Exhaustively" is meant literally: the fact model has 5 states and 2 facts, so
 * the whole input space is 25 combinations and the test enumerates all of them
 * against an independently written oracle. A policy evaluator is exactly the
 * kind of code where a plausible-looking branch quietly inverts one case, and
 * this one decides whether production syncs run.
 *
 * Run:  npx tsx lib/platform/admission/policy-core.test.ts
 */

import { evaluateAdmission, readFactState } from "./policy-core";
import {
  ADMISSION_REASONS,
  type AdmissionRequest,
  type ControlPlaneFact,
  type ControlPlaneFacts,
  type FactState,
} from "./types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const REQ: AdmissionRequest = { work: "REFRESH_EXECUTION" };
const STATES: FactState[] = ["ON", "OFF", "MISSING", "INVALID", "UNAVAILABLE"];

const fact = (key: string, state: FactState): ControlPlaneFact => ({
  key,
  state,
  raw: state === "ON" ? "true" : state === "OFF" ? "false" : state === "INVALID" ? "paused" : null,
});
const facts = (m: FactState, i: FactState): ControlPlaneFacts => ({
  maintenanceMode: fact("maintenance_mode", m),
  ingestionPaused: fact("ingestion_paused", i),
});

/**
 * Independently written oracle. Deliberately re-states the contract from the
 * documentation rather than importing PRECEDENCE — a drift between what the
 * doctrine says and what the code does is precisely what this must catch.
 */
function oracle(m: FactState, i: FactState): string | null {
  for (const [state, onReason] of [[m, "MAINTENANCE_MODE"], [i, "INGESTION_PAUSED"]] as const) {
    if (state === "UNAVAILABLE") return "CONTROL_PLANE_UNAVAILABLE";
    if (state === "INVALID")     return "CONTROL_PLANE_UNREADABLE";
    if (state === "ON")          return onReason;
    // OFF and MISSING both fall through — the documented compatibility default.
  }
  return null; // admitted
}

function main() {
  console.log("1. the complete 5x5 fact space vs an independent oracle");
  {
    let n = 0;
    for (const m of STATES) {
      for (const i of STATES) {
        n++;
        const v = evaluateAdmission(REQ, facts(m, i));
        const want = oracle(m, i);
        check(
          `maintenance=${m} ingestion=${i} → ${want ?? "ADMIT"}`,
          v.reason === want && v.decision === (want === null ? "ADMIT" : "DENY"),
          `got ${v.decision}/${v.reason}`,
        );
      }
    }
    check(`covered all 25 combinations (got ${n})`, n === 25);
  }

  console.log("2. the compatibility default is bounded to MISSING");
  {
    // The one place the contract chooses compatibility over suspicion. If this
    // ever widened to INVALID or UNAVAILABLE, an unreadable pause flag would be
    // silently read as "not paused" — unknown treated as healthy.
    check("both MISSING → ADMIT (nothing configured, nothing changes)",
      evaluateAdmission(REQ, facts("MISSING", "MISSING")).decision === "ADMIT");
    check("INVALID does NOT inherit the missing default",
      evaluateAdmission(REQ, facts("MISSING", "INVALID")).decision === "DENY");
    check("UNAVAILABLE does NOT inherit the missing default",
      evaluateAdmission(REQ, facts("MISSING", "UNAVAILABLE")).decision === "DENY");
    check("unknown is never silently healthy",
      (["INVALID", "UNAVAILABLE"] as FactState[]).every((s) =>
        evaluateAdmission(REQ, facts(s, "OFF")).decision === "DENY" &&
        evaluateAdmission(REQ, facts("OFF", s)).decision === "DENY"));
  }

  console.log("3. precedence is fixed and broadest-first");
  {
    const both = evaluateAdmission(REQ, facts("ON", "ON"));
    check("maintenance outranks ingestion when both are ON", both.reason === "MAINTENANCE_MODE");
    check("ingestion decides when maintenance is off",
      evaluateAdmission(REQ, facts("OFF", "ON")).reason === "INGESTION_PAUSED");
    // Unreadable/unavailable on the FIRST fact wins over an ON second fact —
    // if we cannot read the broader fact we do not get to report the narrower.
    check("an unreadable maintenance flag outranks a paused ingestion flag",
      evaluateAdmission(REQ, facts("INVALID", "ON")).reason === "CONTROL_PLANE_UNREADABLE");
  }

  console.log("4. every non-admitted verdict carries stable, registered evidence");
  {
    for (const m of STATES) {
      for (const i of STATES) {
        const v = evaluateAdmission(REQ, facts(m, i));
        if (v.decision === "ADMIT") {
          check(`ADMIT(${m},${i}) carries no reason/label/evidence`,
            v.reason === null && v.label === null && v.evidence === null);
        } else {
          check(`DENY(${m},${i}) reason is in the registry`,
            v.reason !== null && v.reason in ADMISSION_REASONS);
          check(`DENY(${m},${i}) label comes from the registry (not free text)`,
            v.label === ADMISSION_REASONS[v.reason!]);
          check(`DENY(${m},${i}) names the deciding fact`,
            v.evidence !== null && typeof v.evidence.key === "string" && v.evidence.key.length > 0);
        }
        check(`(${m},${i}) authority is named`, v.authority === "PlatformSetting");
      }
    }
  }

  console.log("5. the core is PURE — deterministic and clock-free");
  {
    const f = facts("ON", "OFF");
    const a = evaluateAdmission(REQ, f);
    const b = evaluateAdmission(REQ, f);
    check("same facts → deeply equal verdict", JSON.stringify(a) === JSON.stringify(b));
    // Determinism is testable BY EQUALITY only because the core stamps no time.
    check("the verdict carries no timestamp", !("evaluatedAt" in a));
    check("verdict has exactly the contract's keys",
      JSON.stringify(Object.keys(a).sort()) ===
        JSON.stringify(["authority", "decision", "evidence", "label", "reason"]));
    // Calling it must not mutate the facts it was given.
    const before = JSON.stringify(f);
    evaluateAdmission(REQ, f);
    check("evaluation does not mutate its input", JSON.stringify(f) === before);
  }

  console.log("6. raw values are interpreted strictly (no coercion)");
  {
    check('"true" → ON',   readFactState("k", "true").state === "ON");
    check('"false" → OFF', readFactState("k", "false").state === "OFF");
    check("null → MISSING",      readFactState("k", null).state === "MISSING");
    check("undefined → MISSING", readFactState("k", undefined).state === "MISSING");
    // A control-plane flag that guesses at its own value is how a pause silently
    // becomes a non-pause. Every one of these must be INVALID, not truthy.
    for (const bad of ["TRUE", "True", "1", "0", "yes", "no", "", " ", "paused", "null"]) {
      check(`${JSON.stringify(bad)} → INVALID`, readFactState("k", bad).state === "INVALID");
    }
    check("the raw value is preserved for evidence", readFactState("k", "TRUE").raw === "TRUE");
    check("MISSING carries no raw value", readFactState("k", null).raw === null);
  }

  console.log("7. the reason registry is well-formed");
  {
    const keys = Object.keys(ADMISSION_REASONS);
    check("every reason has a non-empty human label",
      keys.every((k) => (ADMISSION_REASONS as Record<string, string>)[k].length > 10));
    check("labels are distinct", new Set(Object.values(ADMISSION_REASONS)).size === keys.length);
    check("codes are SCREAMING_SNAKE", keys.every((k) => /^[A-Z][A-Z_]*[A-Z]$/.test(k)));
    // Every registered reason must be REACHABLE. A code nobody can produce is a
    // promise the evaluator does not keep.
    const produced = new Set<string>();
    for (const m of STATES) for (const i of STATES) {
      const r = evaluateAdmission(REQ, facts(m, i)).reason;
      if (r) produced.add(r);
    }
    check(`every registered reason is reachable (${produced.size}/${keys.length})`,
      keys.every((k) => produced.has(k)), `unreachable: ${keys.filter((k) => !produced.has(k)).join(", ")}`);
  }

  if (failures > 0) {
    console.error(`\npolicy-core.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\npolicy-core.test: all passed.");
}

main();
