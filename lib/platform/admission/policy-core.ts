/**
 * lib/platform/admission/policy-core.ts  (OPS-2D-3)
 *
 * The pure admission evaluator. No I/O, no session, no clock, no Prisma —
 * facts in, verdict out. The house pattern (history / convergence / cost /
 * refresh projections all split this way): the RULE is pure and exhaustively
 * unit-tested; `facts.ts` contributes only the read.
 */

import {
  ADMISSION_REASONS,
  type AdmissionRequest,
  type AdmissionReason,
  type AdmissionVerdict,
  type ControlPlaneFact,
  type ControlPlaneFacts,
} from "./types";

/**
 * Fact evaluation order. Fixed, and fixed for a reason: with more than one fact
 * able to deny, an unordered evaluation would return whichever the runtime
 * happened to visit first and the same platform state could produce different
 * reasons on different runs. Determinism is a contract here, not a nicety —
 * these verdicts get written to the execution ledger and read back as evidence.
 *
 * Broadest first: maintenance is a statement about the whole platform, so when
 * both are set the operator hears the bigger fact.
 */
const PRECEDENCE: readonly (keyof ControlPlaneFacts)[] = ["maintenanceMode", "ingestionPaused"];

/** The reason each fact contributes when it is ON. */
const ON_REASON: Record<keyof ControlPlaneFacts, AdmissionReason> = {
  maintenanceMode: "MAINTENANCE_MODE",
  ingestionPaused: "INGESTION_PAUSED",
};

function deny(reason: AdmissionReason, evidence: ControlPlaneFact): AdmissionVerdict {
  return {
    decision: "DENY",
    reason,
    label: ADMISSION_REASONS[reason],
    evidence,
    authority: "PlatformSetting",
  };
}

const ADMITTED: AdmissionVerdict = {
  decision: "ADMIT",
  reason: null,
  label: null,
  evidence: null,
  authority: "PlatformSetting",
};

/**
 * May this work begin, given these facts?
 *
 * PER-STATE CONTRACT — the whole point of the five-state fact, stated once:
 *
 *   ON           the operator declared this state  → DENY with the fact's reason.
 *   OFF          the operator declared it off      → keep evaluating.
 *   MISSING      no operator has ever set it       → treated as OFF.
 *   INVALID      set, but uninterpretable          → DENY (CONTROL_PLANE_UNREADABLE).
 *   UNAVAILABLE  the store could not be read       → DENY (CONTROL_PLANE_UNAVAILABLE).
 *
 * MISSING → OFF is the one place this contract chooses compatibility over
 * suspicion, and it is a deliberate, bounded exception. No control-plane row
 * exists in any environment today; if absence denied, this slice would halt
 * every production sync on deploy. The exception is safe precisely because it is
 * narrow — absence is treated as "off" ONLY for facts whose documented default
 * is off, and INVALID and UNAVAILABLE (the states that mean "we do not know")
 * still deny. Unknown is never silently healthy; only *never-configured* is.
 *
 * INVALID → DENY is the deliberately uncomfortable one. A single mistyped value
 * in one settings row will stop this class of work. The alternative is worse: a
 * pause flag nobody can parse being read as "not paused" is exactly how an
 * operator's declared outage gets ignored. The blast radius is bounded — the
 * only writer is a typed setter, so an invalid value can arrive only by direct
 * database edit — and the verdict names the offending key and raw value, so the
 * fault is loud rather than silent.
 *
 * Deterministic: the same request and facts always produce an equal verdict.
 */
export function evaluateAdmission(
  _request: AdmissionRequest,
  facts: ControlPlaneFacts,
): AdmissionVerdict {
  for (const key of PRECEDENCE) {
    const fact = facts[key];
    switch (fact.state) {
      case "UNAVAILABLE":
        return deny("CONTROL_PLANE_UNAVAILABLE", fact);
      case "INVALID":
        return deny("CONTROL_PLANE_UNREADABLE", fact);
      case "ON":
        return deny(ON_REASON[key], fact);
      case "OFF":
      case "MISSING":
        continue;
    }
  }
  return ADMITTED;
}

/**
 * Interpret one raw setting value into a fact state.
 *
 * Only the two literal strings the typed setter writes are accepted. No
 * coercion, no truthiness, no case-folding: "TRUE", "1", "yes" and "" are all
 * INVALID, because a control-plane flag that guesses at its own value is how a
 * pause silently becomes a non-pause.
 */
export function readFactState(key: string, raw: string | null | undefined): ControlPlaneFact {
  if (raw === null || raw === undefined) return { key, state: "MISSING", raw: null };
  if (raw === "true")  return { key, state: "ON",  raw };
  if (raw === "false") return { key, state: "OFF", raw };
  return { key, state: "INVALID", raw };
}
