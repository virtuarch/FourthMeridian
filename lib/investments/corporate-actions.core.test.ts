/**
 * lib/investments/corporate-actions.core.test.ts
 *
 * V26-S1-CA — the corporate-action terms authority. Standalone tsx, pure.
 *
 * Calibrated on the real action: TQQQ, effective 2025-11-20, Tiingo
 * `splitFactor: 2.0`. The event Plaid emitted for it carries `ratio: NULL`, and
 * every case below exists because that combination stopped a walk.
 */

import {
  splitFactorToRatio,
  assertPersistableTerms,
  resolveTerms,
  actionKey,
  isCorporateActionGrade,
  CORPORATE_ACTION_GRADES,
  type CorporateActionTermsInput,
} from "./corporate-actions.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function throws(fn: () => void): boolean {
  try { fn(); return false; } catch { return true; }
}

const TQQQ = "instr_tqqq";
const DATE = "2025-11-20";
const terms = (over: Partial<CorporateActionTermsInput> = {}): CorporateActionTermsInput => ({
  instrumentId: TQQQ, effectiveDate: DATE, kind: "SPLIT", ratio: 2,
  grade: "CORROBORATED", source: "tiingo", ...over,
});

function main(): void {
  console.log("V26-S1-CA — corporate action terms\n");

  // ── A. splitFactor → ratio: 1.0 is NOT an action ──────────────────────────
  {
    check("A. the real TQQQ factor becomes a ratio", splitFactorToRatio(2.0) === 2);
    check("A. a reverse split survives", splitFactorToRatio(0.1) === 0.1);
    check("A. 1.0 is 'nothing happened', never terms", splitFactorToRatio(1.0) === null);
    check("A. 1.0 within float noise is still nothing", splitFactorToRatio(1 + 1e-12) === null);
    check("A. zero / negative / non-finite are refused",
      splitFactorToRatio(0) === null && splitFactorToRatio(-2) === null &&
      splitFactorToRatio(NaN) === null && splitFactorToRatio(Infinity) === null);
    check("A. a missing or non-numeric field is refused",
      splitFactorToRatio(undefined) === null && splitFactorToRatio("2") === null);
  }

  // ── B. The write guard — INFERRED may never be persisted ──────────────────
  {
    check("B. a corroborated vendor term is persistable", !throws(() => assertPersistableTerms(terms())));
    check("B. a stated (user/import) term is persistable",
      !throws(() => assertPersistableTerms(terms({ grade: "STATED", source: "import" }))));
    check("B. INFERRED is REFUSED even though it is a known grade",
      isCorporateActionGrade("INFERRED") && throws(() => assertPersistableTerms(terms({ grade: "INFERRED" }))));
    check("B. an unknown grade is refused", throws(() => assertPersistableTerms(terms({ grade: "PROBABLY" }))));
    check("B. an unknown kind is refused", throws(() => assertPersistableTerms(terms({ kind: "MERGER" }))));
    check("B. a SPLIT with no ratio is refused", throws(() => assertPersistableTerms(terms({ ratio: null }))));
    check("B. a SPLIT with a non-positive ratio is refused",
      throws(() => assertPersistableTerms(terms({ ratio: 0 }))) &&
      throws(() => assertPersistableTerms(terms({ ratio: -2 }))));
    check("B. a sourceless term is refused", throws(() => assertPersistableTerms(terms({ source: "  " }))));
  }

  // ── C. Selection: STATED outranks CORROBORATED ────────────────────────────
  {
    const resolved = resolveTerms([
      terms({ grade: "CORROBORATED", source: "tiingo", ratio: 2 }),
      terms({ grade: "STATED", source: "import", ratio: 2 }),
    ]);
    const t = resolved.get(actionKey(TQQQ, DATE, "SPLIT"))!;
    check("C. first-party evidence wins over a vendor field", t.grade === "STATED" && t.source === "import");
    check("C. agreement is not a dispute", t.disputed === false);
  }

  // ── D. Disagreement is RECORDED, never averaged ───────────────────────────
  {
    const resolved = resolveTerms([
      terms({ grade: "CORROBORATED", source: "tiingo", ratio: 2 }),
      terms({ grade: "CORROBORATED", source: "other", ratio: 3 }),
    ]);
    const t = resolved.get(actionKey(TQQQ, DATE, "SPLIT"))!;
    check("D. a winner still applies", t.ratio === 2 || t.ratio === 3);
    check("D. the ratio is one a source STATED — never an average", t.ratio !== 2.5);
    check("D. the disagreement is flagged", t.disputed === true);
  }

  // ── E. Determinism — equal grades resolve identically whatever the row order ─
  {
    const rows = [
      terms({ grade: "CORROBORATED", source: "zeta", ratio: 2 }),
      terms({ grade: "CORROBORATED", source: "alpha", ratio: 2 }),
    ];
    const a = resolveTerms(rows).get(actionKey(TQQQ, DATE, "SPLIT"))!;
    const b = resolveTerms([...rows].reverse()).get(actionKey(TQQQ, DATE, "SPLIT"))!;
    check("E. same answer in both orders", a.source === b.source);
    check("E. the tie-break is the source name, not row position", a.source === "alpha");
  }

  // ── F. Non-licensing grades never reach a consumer ────────────────────────
  {
    const resolved = resolveTerms([terms({ grade: "INFERRED", source: "arithmetic" })]);
    check("F. an inferred term resolves to NOTHING (defence in depth)", resolved.size === 0);
  }

  // ── G. Keys separate instruments, dates and kinds ─────────────────────────
  {
    const resolved = resolveTerms([
      terms(),
      terms({ effectiveDate: "2026-01-15" }),
      terms({ instrumentId: "instr_other" }),
    ]);
    check("G. three distinct actions stay distinct", resolved.size === 3);
    check("G. the key is (instrument, date, kind)",
      actionKey(TQQQ, DATE, "SPLIT") === `${TQQQ}|${DATE}|SPLIT`);
  }

  // ── H. The grade ordering is the licensing ordering ───────────────────────
  check("H. INFERRED is declared weakest", CORPORATE_ACTION_GRADES[0] === "INFERRED");
  check("H. STATED is declared strongest", CORPORATE_ACTION_GRADES.at(-1) === "STATED");

  console.log(failures === 0 ? "\nAll corporate-action checks passed" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
