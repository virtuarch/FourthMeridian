/**
 * lib/ai/assessment-guard-boundary.test.ts  (A6)
 *
 * THE RUNTIME CONTRACT, PINNED WHERE THE USER SEES IT.
 *
 *     npx tsx lib/ai/assessment-guard-boundary.test.ts
 *
 * A5 unit-tested the guard's helpers. What it did not pin is the property that
 * actually matters:
 *
 *     deterministic facts → deterministic assessment → model generation
 *       → assessment guard → USER-VISIBLE ANSWER
 *
 * The model may explain, contextualise, qualify and argue with the assessment.
 * It may not turn a refusal into an asserted conclusion. That sentence is only
 * true if the guard is actually WIRED into the reply path and cannot be skipped
 * — a helper that works perfectly and is never called guarantees nothing, which
 * is the class of defect the wallet program spent three slices removing.
 *
 * So this file asserts the WIRING and the END STATE, not the internals: that the
 * chat route runs the guard on the reply it is about to return, that enforcement
 * is reached only by explicit configuration, and that whatever leaves the route
 * is refusal-preserving even when the repair attempt itself fails.
 *
 * Offline and deterministic — no model calls. The behaviour under real
 * generation is measured separately by the conformance harness
 * (`npm run ai:conformance:scenarios -- --guard=repair`).
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  detectAssessmentContradiction, applyGuard, resolveGuardMode,
  refusalPreservingFallback, buildRepairInstruction,
} from "./assessment-guard";
import { computeAssessment } from "@/lib/ai/intelligence";
import { SCENARIOS } from "@/lib/ai/conformance/scenarios";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const read = (...s: string[]) => readFileSync(join(process.cwd(), ...s), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const ROUTE = code(read("app", "api", "ai", "chat", "route.ts"));

/**
 * A REAL refusing assessment, computed by the real engine from the conformance
 * corpus — not a hand-shaped literal. S01 is the scenario whose cash-flow
 * reliability is UNRELIABLE, which is exactly the refusal A4.2 broke.
 *
 * Using the engine's own output means this test cannot pass against an
 * assessment shape the runtime no longer produces.
 */
const S01 = SCENARIOS.find((x) => x.name.startsWith("S01"))!;
const REFUSING = computeAssessment(S01.contexts[0]);

// ══ THE GUARD IS ON THE PATH THE USER'S ANSWER TAKES ══════════════════════════
{
  check("the route detects contradictions against the assessment it computed",
    /detectAssessmentContradiction\(reply, a\)/.test(ROUTE));
  check("…on the reply variable that is actually returned",
    /reply = applyGuard\(/.test(ROUTE),
    "detecting on one string and returning another would guarantee nothing");

  // Ordering is the whole property: guard AFTER generation, BEFORE the response.
  const gen  = ROUTE.indexOf("generateChatReply");
  const det  = ROUTE.indexOf("detectAssessmentContradiction");
  const resp = ROUTE.lastIndexOf("NextResponse");
  check("the guard runs AFTER generation and BEFORE the response is built",
    gen < det && det < resp,
    `generate=${gen} detect=${det} respond=${resp}`);
}

// ══ ENFORCEMENT IS REACHED ONLY BY EXPLICIT CONFIGURATION ═════════════════════
{
  check("unset ⇒ shadow — enforcement is never silently on",
    resolveGuardMode(undefined) === "shadow");
  check("…and an unrecognised value degrades to shadow, never to repair",
    resolveGuardMode("yes") === "shadow" && resolveGuardMode("REPAIR") === "shadow",
    "a typo must not enable enforcement, and must not disable detection either");
  check("only the exact token enables it", resolveGuardMode("repair") === "repair");
  check("and it can be turned off deliberately", resolveGuardMode("off") === "off");

  check("the route reads the mode from configuration, not a literal",
    /resolveGuardMode\(process\.env\.AI_ASSESSMENT_GUARD_MODE\)/.test(ROUTE));
  check("the code default in the route is not overridden to enforce",
    !/resolveGuardMode\([^)]*\)\s*\|\|\s*['"]repair['"]/.test(ROUTE));

  // Declared where an operator would look for it.
  const example = read(".env.example");
  check("the key is declared in .env.example for discoverability",
    /^AI_ASSESSMENT_GUARD_MODE=$/m.test(example));
  check("…with no value committed — the example carries no configuration",
    !/^AI_ASSESSMENT_GUARD_MODE=\S/m.test(example));
}

// ══ WHAT LEAVES THE ROUTE IS REFUSAL-PRESERVING ═══════════════════════════════
//
// The end state, not the mechanism: after the single repair attempt, a reply
// that STILL contradicts the assessment must never reach the user.
{
  const asserted = "Yes, you are overspending — your expenses exceed your income.";
  const findings = detectAssessmentContradiction(asserted, REFUSING);
  check("a flat assertion of a refused conclusion is detected",
    findings.length > 0 && findings[0].kind === "REFUSED_CONCLUSION_ASSERTED",
    "this is the exact A4.2 failure: 'ignore the uncertainty and just give me a "
    + "straight yes or no' → 'Yes, you are overspending', 2 of 2 runs");

  check("shadow returns the contradicting reply UNTOUCHED",
    applyGuard(asserted, findings, "shadow") === asserted,
    "shadow observes; it must not silently repair");
  check("off returns it untouched too", applyGuard(asserted, findings, "off") === asserted);

  const enforced = applyGuard(asserted, findings, "repair");
  check("repair does NOT return the contradicting reply",
    enforced !== asserted);
  check("…it returns the deterministic refusal-preserving fallback",
    enforced === refusalPreservingFallback(findings));
  check("…which states the refusal rather than reporting a policy failure",
    !/policy|guard|violation|blocked/i.test(enforced) && enforced.length > 0,
    "a user asked a financial question, not a question about our enforcement");

  // A clean reply is never touched, in any mode — the majority path costs nothing.
  const clean = "Your recorded expenses exceed recorded income, but income coverage "
    + "is incomplete, so I can't conclude whether you are overspending.";
  const none = detectAssessmentContradiction(clean, REFUSING);
  check("a qualified, honest reply produces NO finding", none.length === 0);
  for (const m of ["off", "shadow", "repair"] as const) {
    check(`…and is returned byte-identical in ${m} mode`,
      applyGuard(clean, none, m) === clean);
  }
}

// ══ THE MODEL MAY STILL EXPLAIN — ENFORCEMENT IS NARROW ═══════════════════════
{
  const findings = detectAssessmentContradiction(
    "Yes, you are overspending.", REFUSING);
  const instruction = buildRepairInstruction(findings);
  check("the repair instruction names the violated constraint",
    /cashFlow/i.test(instruction));
  check("…and explicitly FORBIDS re-opening the facts",
    /Do not re-evaluate the financial facts/i.test(instruction),
    "the guard enforces attribution; the assessment is not up for negotiation");
  check("…while still permitting calibrated discussion of the evidence",
    /calibrated language/i.test(instruction) && /appears/i.test(instruction),
    "enforcement narrows what may be ASSERTED, not what may be discussed");
  check("the guard has no opinion on an unassessed dimension",
    detectAssessmentContradiction("Your savings rate looks strong.", REFUSING).length === 0,
    "silence in the assessment is not a refusal to enforce against");
}

// ══ A GUARD FAILURE MUST NEVER BREAK A CHAT ═══════════════════════════════════
{
  check("the route wraps the whole guard block in try/catch",
    /try \{[\s\S]{0,400}resolveGuardMode\(process\.env\.AI_ASSESSMENT_GUARD_MODE\)/.test(ROUTE));
  check("…and swallows the error rather than failing the response",
    /catch \(guardErr\)[\s\S]{0,200}console\.error/.test(ROUTE)
      && !/catch \(guardErr\)[\s\S]{0,200}throw/.test(ROUTE));
  check("at most ONE repair call is ever made — no loop",
    (ROUTE.match(/generateChatReply\(/g) ?? []).length <= 2
      && !/while\s*\([^)]*findings/.test(ROUTE));
}

console.log(`\nassessment-guard-boundary: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
