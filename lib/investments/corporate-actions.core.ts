/**
 * lib/investments/corporate-actions.core.ts
 *
 * V26-S1-CA — WHAT WERE THE TERMS OF THIS CORPORATE ACTION, AND MAY WE USE THEM?
 *
 * Pure: no Prisma, no DB, no clock, no network.
 *
 * ── The one question this module answers ─────────────────────────────────────
 * A backward quantity replay reaches a SPLIT and must decide: invert it, or stop
 * here and refuse the history behind it. It can only invert what it knows the
 * terms of. This module decides which stated terms count as knowing.
 *
 * ── The grade is the whole design ────────────────────────────────────────────
 * Three routes to a split ratio exist in this system's data, and they are NOT
 * equally trustworthy. TQQQ's 2025-11-20 split, measured:
 *
 *   A  Tiingo's `splitFactor` on that date                        →  2.0
 *   B  the broker's stated split price 50.025 against Tiingo's
 *      independent prior close 100.05 (a split is value-neutral)  →  2.0
 *   C  the event's own quantity (10) against the post-split
 *      holding proven by a later sale (20)                        →  2.0
 *
 * All three agree. They are still not interchangeable.
 *
 * A is an INDEPENDENT SOURCE STATING THE TERM — a documented, vendor-maintained
 * field covering every US listed security. That is corroboration.
 *
 * C is OUR OWN ARITHMETIC over the provider's row, and it rests on an
 * unestablished premise: that a provider reports a split as the share DELTA
 * rather than as the new TOTAL or as a paired remove/add. The live corpus
 * contains exactly ONE split. One observation cannot establish a convention, and
 * a ratio that is wrong in the "new total" direction is wrong by a factor of the
 * ratio squared — silently, and only in history.
 *
 * So: **a corporate action may be inverted when an independent source states its
 * terms; never when only our own arithmetic implies them.** INFERRED is
 * therefore not a persistable grade and not a licensing grade. It exists in this
 * vocabulary solely so a future consumer can COMPUTE it and CONTRADICT a stated
 * term — disagreement is a finding, not a fallback.
 *
 * Nothing here names a vendor, an account or a user.
 */

/** Corporate-action kinds this authority can carry terms for. */
export const CORPORATE_ACTION_KINDS = ["SPLIT"] as const;
export type CorporateActionKind = (typeof CORPORATE_ACTION_KINDS)[number];

/**
 * How well the terms are evidenced. Ordered weakest → strongest for selection.
 * `INFERRED` is never persisted and never licenses — see the header.
 */
export const CORPORATE_ACTION_GRADES = ["INFERRED", "CORROBORATED", "STATED"] as const;
export type CorporateActionGrade = (typeof CORPORATE_ACTION_GRADES)[number];

/** Grades that may license a backward replay to invert an action. */
const LICENSING_GRADES: ReadonlySet<string> = new Set<string>(["STATED", "CORROBORATED"]);

export interface CorporateActionTermsInput {
  instrumentId:  string;
  effectiveDate: string; // YYYY-MM-DD
  kind:          string;
  ratio:         number | null;
  grade:         string;
  source:        string;
}

export function isCorporateActionKind(v: string): v is CorporateActionKind {
  return (CORPORATE_ACTION_KINDS as readonly string[]).includes(v);
}

export function isCorporateActionGrade(v: string): v is CorporateActionGrade {
  return (CORPORATE_ACTION_GRADES as readonly string[]).includes(v);
}

/**
 * The write-time guard, mirroring `assertCanonicalCompleteness`: a reserved
 * String column may only ever receive a member of its declared vocabulary, and
 * `INFERRED` may never be written at all. Throws (programmer error) rather than
 * coercing — a mapping bug must fail loudly, not smuggle an unlicensed grade
 * into a column that licenses money.
 */
export function assertPersistableTerms(t: CorporateActionTermsInput): void {
  if (!isCorporateActionKind(t.kind)) {
    throw new Error(`[corporate-actions] refusing to write non-canonical kind "${t.kind}" — allowed: ${CORPORATE_ACTION_KINDS.join(", ")}`);
  }
  if (!isCorporateActionGrade(t.grade)) {
    throw new Error(`[corporate-actions] refusing to write non-canonical grade "${t.grade}" — allowed: ${CORPORATE_ACTION_GRADES.join(", ")}`);
  }
  if (!LICENSING_GRADES.has(t.grade)) {
    throw new Error(`[corporate-actions] refusing to persist grade "${t.grade}" — only stated or corroborated terms are evidence`);
  }
  if (t.kind === "SPLIT" && (t.ratio == null || !Number.isFinite(t.ratio) || t.ratio <= 0)) {
    throw new Error(`[corporate-actions] refusing to write a SPLIT with a non-positive ratio (${t.ratio})`);
  }
  if (!t.source.trim()) {
    throw new Error("[corporate-actions] refusing to write terms with no source");
  }
}

/** A key that identifies one action across sources. */
export function actionKey(instrumentId: string, effectiveDate: string, kind: string): string {
  return `${instrumentId}|${effectiveDate}|${kind}`;
}

export interface ResolvedTerms {
  ratio:  number | null;
  grade:  CorporateActionGrade;
  source: string;
  /** True when two licensing sources state DIFFERENT terms for the same action. */
  disputed: boolean;
}

/**
 * Pick the terms that apply for each (instrument, date, kind), from possibly
 * several sources.
 *
 * Deterministic and total. Selection is by GRADE first (STATED beats
 * CORROBORATED — a statement from the user or their own statement outranks a
 * vendor's field), then by `source` alphabetically so two sources of equal grade
 * resolve identically on every run rather than by row order.
 *
 * DISAGREEMENT IS RECORDED, NOT AVERAGED. When two licensing sources state
 * different ratios for the same action, the winner still applies — refusing
 * outright would throw away a corroborated term because a second source exists —
 * but `disputed` is set so the consumer can surface it. Averaging two ratios
 * would produce a number no source stated, which is the failure mode every
 * refusal in this engine exists to prevent.
 *
 * Non-licensing grades are dropped here as well as at write time: defence in
 * depth on the one rule that decides whether history may be reconstructed.
 */
export function resolveTerms(
  rows: readonly CorporateActionTermsInput[],
): Map<string, ResolvedTerms> {
  const byKey = new Map<string, CorporateActionTermsInput[]>();
  for (const r of rows) {
    if (!LICENSING_GRADES.has(r.grade)) continue;
    const k = actionKey(r.instrumentId, r.effectiveDate, r.kind);
    const list = byKey.get(k) ?? [];
    list.push(r);
    byKey.set(k, list);
  }

  const out = new Map<string, ResolvedTerms>();
  for (const [k, list] of byKey) {
    const sorted = [...list].sort((a, b) => {
      const ga = CORPORATE_ACTION_GRADES.indexOf(a.grade as CorporateActionGrade);
      const gb = CORPORATE_ACTION_GRADES.indexOf(b.grade as CorporateActionGrade);
      return gb - ga || a.source.localeCompare(b.source); // stronger grade first
    });
    const winner = sorted[0];
    const disputed = sorted.some(
      (r) => r.ratio != null && winner.ratio != null && Math.abs(r.ratio - winner.ratio) > 1e-9,
    );
    out.set(k, {
      ratio:  winner.ratio,
      grade:  winner.grade as CorporateActionGrade,
      source: winner.source,
      disputed,
    });
  }
  return out;
}

/**
 * A split factor as a usable ratio, or null when the vendor stated no action.
 *
 * Tiingo reports `splitFactor: 1.0` on every ordinary day — "nothing happened" —
 * and the true factor on the effective date. 1.0 is therefore NOT terms and must
 * never be persisted as an action: a table full of no-ops would make "we have
 * terms for this date" meaningless. Anything non-positive or non-finite is
 * refused for the same reason a non-positive price is dropped upstream.
 */
export function splitFactorToRatio(splitFactor: unknown): number | null {
  if (typeof splitFactor !== "number" || !Number.isFinite(splitFactor) || splitFactor <= 0) return null;
  if (Math.abs(splitFactor - 1) <= 1e-9) return null; // no action on this date
  return splitFactor;
}
