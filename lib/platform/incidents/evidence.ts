/**
 * lib/platform/incidents/evidence.ts  (PB-1 Phase 1 — the ONLY evidence builders)
 *
 * `SyncIssue.resolutionEvidence`, `SyncIssueOccurrence.evidenceSummary` and the
 * archive's copy are written ONLY through the typed builders below (pinned in
 * incident-boundary.test.ts). Each builder copies an explicit allowlist of
 * ids, codes, enums, timestamps and counts — never `detail`, never an error
 * message, never provider text — and refuses anything over the DB size cap.
 *
 * ── §12 P2.1 — A SKIP IS NEVER PROOF ─────────────────────────────────────────
 * A stage that was SKIPPED (cost freeze, billable gate, plan restriction,
 * cooldown) or never attempted proves nothing about recovery. It may be
 * RECORDED — as `nonProof` — so the history says what happened, but
 * `proofCount` counts SUCCEEDED facts only, and `mayAdvanceRecovery` is the
 * one gate any resolver must pass to move an episode to RECOVERING or
 * RESOLVED. A SKIPPED-only record can never pass it.
 *
 * Pure.
 */

import type { RemovedSubjectState } from "./invariant";

/** The DB CHECK cap (pg_column_size ≤ 4096); measured here on the JSON text, which is never smaller. */
export const EVIDENCE_MAX_BYTES = 4096;
export const TIMELINE_MAX_BYTES = 8192;

const MAX_FACTS = 8;
const MAX_SUBJECTS = 20;

/** One stage result an evidence rule looked at. Ids and enums only. */
export interface StageFact {
  source: "RefreshEndpointResult" | "InvestmentEventCoverage";
  executionId: string | null;
  endpoint: string;
  /** SUCCEEDED is the only proof. SKIPPED / NOT_ATTEMPTED / FAILED are recorded as non-proof. */
  status: "SUCCEEDED" | "FAILED" | "SKIPPED" | "NOT_ATTEMPTED" | "PROVIDER_LIMITED";
  skipReason?: string | null;
  completedAt: string | null;
}

export interface SubjectRecord {
  kind: "PLAID_ITEM" | "FINANCIAL_ACCOUNT";
  id: string;
  state: "LIVE" | RemovedSubjectState;
}

export interface ResolutionEvidence {
  /** Rule id, a registry-shaped code. */
  rule: string;
  /** SUCCEEDED facts — the only thing that proves recovery. */
  proof: StageFact[];
  /** SKIPPED / NOT_ATTEMPTED / FAILED / PROVIDER_LIMITED facts — recorded, never counted. */
  nonProof: StageFact[];
  proofCount: number;
  /** §5 — present on SUBJECT_REMOVED. */
  subject?: SubjectRecord & { state: RemovedSubjectState; observedAt: string };
  /** §12 P2.2 — each subject's basis. */
  subjects?: SubjectRecord[];
  subjectsTruncated?: boolean;
}

function pickFact(f: StageFact): StageFact {
  return {
    source: f.source,
    executionId: typeof f.executionId === "string" ? f.executionId : null,
    endpoint: String(f.endpoint),
    status: f.status,
    skipReason: f.status === "SKIPPED" && typeof f.skipReason === "string" ? f.skipReason : null,
    completedAt: typeof f.completedAt === "string" ? f.completedAt : null,
  };
}

function pickSubject(s: SubjectRecord): SubjectRecord {
  return { kind: s.kind, id: s.id, state: s.state };
}

/** Throws when the serialised value would breach the DB cap — a refused write, never a truncated one. */
function capped<T>(value: T, max: number): T {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > max) throw new Error(`incident evidence is ${bytes} B, over the ${max} B cap`);
  return value;
}

/** The typed resolution-evidence builder. */
export function buildResolutionEvidence(input: {
  rule: string;
  facts?: readonly StageFact[];
  subject?: SubjectRecord & { state: RemovedSubjectState };
  observedAt?: Date;
  subjects?: readonly SubjectRecord[];
}): ResolutionEvidence {
  const facts = (input.facts ?? []).map(pickFact);
  const proof = facts.filter((f) => f.status === "SUCCEEDED").slice(0, MAX_FACTS);
  const nonProof = facts.filter((f) => f.status !== "SUCCEEDED").slice(0, MAX_FACTS);
  const subjects = (input.subjects ?? []).map(pickSubject);
  const out: ResolutionEvidence = { rule: input.rule, proof, nonProof, proofCount: proof.length };
  if (input.subject) {
    out.subject = { ...pickSubject(input.subject), state: input.subject.state, observedAt: (input.observedAt ?? new Date()).toISOString() };
  }
  if (subjects.length) {
    out.subjects = subjects.slice(0, MAX_SUBJECTS);
    out.subjectsTruncated = subjects.length > MAX_SUBJECTS;
  }
  return capped(out, EVIDENCE_MAX_BYTES);
}

/**
 * THE gate for RECOVERING / RESOLVED-by-evidence: at least one SUCCEEDED proof.
 * A record holding only SKIPPED or not-attempted facts never passes.
 */
export function mayAdvanceRecovery(e: Pick<ResolutionEvidence, "proof" | "proofCount">): boolean {
  return e.proofCount > 0 && e.proof.length > 0 && e.proof.every((f) => f.status === "SUCCEEDED");
}

/** §8 — the frozen summary of the failing execution at observation time. */
export interface OccurrenceEvidenceSummary {
  executionId: string | null;
  runId: string | null;
  jobRunId: string | null;
  jobName: string | null;
  /** The stage that was running; never "proof" of anything. */
  stage: string | null;
}

export function buildOccurrenceEvidenceSummary(i: OccurrenceEvidenceSummary): OccurrenceEvidenceSummary {
  const s = (x: unknown) => (typeof x === "string" && x !== "" ? x.slice(0, 128) : null);
  return capped({ executionId: s(i.executionId), runId: s(i.runId), jobRunId: s(i.jobRunId), jobName: s(i.jobName), stage: s(i.stage) }, EVIDENCE_MAX_BYTES);
}

/**
 * Re-shape a STORED resolutionEvidence through the typed builder before it is
 * copied anywhere (the archive). Anything that does not conform is dropped to
 * null — a stored value is never trusted to be allowlist-only.
 */
export function reshapeStoredEvidence(stored: unknown): ResolutionEvidence | null {
  if (typeof stored !== "object" || stored === null) return null;
  const e = stored as Record<string, unknown>;
  if (typeof e.rule !== "string" || !/^[A-Z0-9_]{2,64}$/.test(e.rule)) return null;
  const facts = [...(Array.isArray(e.proof) ? e.proof : []), ...(Array.isArray(e.nonProof) ? e.nonProof : [])]
    .filter((f): f is StageFact => typeof f === "object" && f !== null
      && ["SUCCEEDED", "FAILED", "SKIPPED", "NOT_ATTEMPTED", "PROVIDER_LIMITED"].includes((f as StageFact).status)
      && ["RefreshEndpointResult", "InvestmentEventCoverage"].includes((f as StageFact).source)
      && typeof (f as StageFact).endpoint === "string" && /^[A-Z_]{2,64}$/.test((f as StageFact).endpoint));
  const isSubject = (x: unknown): x is SubjectRecord => typeof x === "object" && x !== null
    && ["PLAID_ITEM", "FINANCIAL_ACCOUNT"].includes((x as SubjectRecord).kind)
    && typeof (x as SubjectRecord).id === "string" && ["LIVE", "DELETED", "REVOKED", "MISSING"].includes((x as SubjectRecord).state);
  const subj = e.subject;
  const subject = isSubject(subj) && subj.state !== "LIVE" ? (subj as SubjectRecord & { state: RemovedSubjectState }) : undefined;
  const observed = subject && typeof (subj as { observedAt?: unknown }).observedAt === "string" ? new Date((subj as { observedAt: string }).observedAt) : undefined;
  try {
    return buildResolutionEvidence({
      rule: e.rule, facts, subject,
      observedAt: observed && Number.isFinite(observed.getTime()) ? observed : undefined,
      subjects: Array.isArray(e.subjects) ? e.subjects.filter(isSubject) : [],
    });
  } catch {
    return null;
  }
}
