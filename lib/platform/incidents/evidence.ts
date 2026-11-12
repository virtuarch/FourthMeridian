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
/**
 * Where a stage fact came from. `BalanceObservation` (FIN-A2) is an observed
 * balance written for the incident's own account — the write that proves a
 * BALANCE_UNOBSERVED condition false. It may happen outside a refresh
 * execution (re-exchange), so `executionId` is null there, never invented.
 * The fact carries no amount: the proof is that a balance was observed, not
 * what it was.
 */
export const STAGE_FACT_SOURCES = ["RefreshEndpointResult", "InvestmentEventCoverage", "BalanceObservation"] as const;
export type StageFactSource = (typeof STAGE_FACT_SOURCES)[number];

export interface StageFact {
  source: StageFactSource;
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

/**
 * PB-1 S6 — an OPERATOR_RESOLVED closure's evidence. Design §8: an operator
 * closure records a REFERENCE, never the reason text — the note lives in the
 * AuditLog row (never deleted), reached by `auditId`. No operator user id is
 * copied here either: the live row carries `resolvedById`, and the archive
 * (which has no such column) keeps only this audit reference, so the actor is
 * resolved through the audit trail at the tier that may see it.
 */
export interface OperatorClosureRecord {
  /** AuditLog.id of the SYNC_INCIDENT_RESOLVED row (recordOperatorAction). */
  auditId: string;
  /** How the operator held authority: a platform grant, or System Admin break-glass. */
  via: "PLATFORM_GRANT" | "SYSTEM_ADMIN";
  /** The registry resolution reason (OPERATOR_RESOLUTION_REASON_CODES). */
  reasonCode: string;
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
  /** PB-1 S6 — present on OPERATOR_RESOLVED (rule OPERATOR_RESOLVED_V1). Never proof. */
  operator?: OperatorClosureRecord;
}

const OPERATOR_VIA = ["PLATFORM_GRANT", "SYSTEM_ADMIN"] as const;
function pickOperator(o: unknown): OperatorClosureRecord | undefined {
  if (typeof o !== "object" || o === null) return undefined;
  const r = o as Record<string, unknown>;
  if (typeof r.auditId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(r.auditId)) return undefined;
  if (!(OPERATOR_VIA as readonly unknown[]).includes(r.via)) return undefined;
  if (typeof r.reasonCode !== "string" || !/^[A-Z0-9_]{2,64}$/.test(r.reasonCode)) return undefined;
  return { auditId: r.auditId, via: r.via as OperatorClosureRecord["via"], reasonCode: r.reasonCode };
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
  operator?: OperatorClosureRecord;
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
  if (input.operator !== undefined) {
    const op = pickOperator(input.operator);
    if (!op) throw new Error("operator closure evidence must be {auditId, via, reasonCode} (ids and codes only)");
    out.operator = op;
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
 * Incident drawer PR-A — the READ side of the occurrence summary: the select an
 * investigation uses for its newest occurrence, and the reshaper of that row.
 * A stored value is never trusted: only `jobName` / `jobRunId` strings survive
 * (capped like the builder), and a summary naming no job is "no component".
 */
export const OCCURRENCE_COMPONENT_SELECT = { evidenceSummary: true } as const;

export function occurrenceComponentOfRow(row: unknown): { jobName: string; jobRunId: string | null } | null {
  if (typeof row !== "object" || row === null) return null;
  const s = (row as { evidenceSummary?: unknown }).evidenceSummary;
  if (typeof s !== "object" || s === null || Array.isArray(s)) return null;
  const e = s as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" && x !== "" ? x.slice(0, 128) : null);
  const jobName = str(e.jobName);
  return jobName ? { jobName, jobRunId: str(e.jobRunId) } : null;
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
      && (STAGE_FACT_SOURCES as readonly string[]).includes((f as StageFact).source)
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
      operator: pickOperator(e.operator),
    });
  } catch {
    return null;
  }
}

// ── PB-1 Phase 2 — the read-side DIGEST (codes and counts only) ─────────────
//
// The stored evidence is raw JSONB (≤ 4 KB) and NEVER crosses into an
// audience-scoped output. The incident-intelligence module reads it only as
// this digest, which this builder derives: a registry rule code, counts, one
// timestamp and a removed-subject STATE. No execution id, no subject id, no
// skip reason, no free text.
//
// The intelligence loader selects the column by spreading
// EVIDENCE_DIGEST_SELECT and hands the row back to `evidenceDigestOf`, so the
// raw column is named only here (pinned in incident-boundary.test.ts §8).

export interface ResolutionEvidenceDigest {
  /** The resolver rule, a registry-shaped code. */
  rule: string;
  /** SUCCEEDED facts — the only proof. */
  proofCount: number;
  /** Recorded non-proof facts (SKIPPED / NOT_ATTEMPTED / FAILED / PROVIDER_LIMITED). */
  nonProofCount: number;
  /** `mayAdvanceRecovery` over the stored proof. */
  mayAdvance: boolean;
  /** The newest SUCCEEDED proof's completion instant, when recorded. */
  lastProofAt: string | null;
  /** §5 — the removed subject's STATE on a SUBJECT_REMOVED closure (never its id). */
  removedSubjectState: RemovedSubjectState | null;
  /** §12 P2.2 — per-subject bases recorded (count only), and whether the list was capped. */
  subjectCount: number;
  subjectsTruncated: boolean;
}

/** Spread into a SyncIssue `select` to read the stored evidence for digesting. */
export const EVIDENCE_DIGEST_SELECT = { resolutionEvidence: true } as const;

/** Digest one stored value. Non-conforming input ⇒ null (re-shaped through the typed builder first). */
export function digestStoredEvidence(stored: unknown): ResolutionEvidenceDigest | null {
  const e = reshapeStoredEvidence(stored);
  if (!e) return null;
  const proofTimes = e.proof.map((f) => f.completedAt).filter((t): t is string => typeof t === "string" && Number.isFinite(Date.parse(t)));
  const lastProofAt = proofTimes.length ? new Date(Math.max(...proofTimes.map((t) => Date.parse(t)))).toISOString() : null;
  return {
    rule: e.rule,
    proofCount: e.proofCount,
    nonProofCount: e.nonProof.length,
    mayAdvance: mayAdvanceRecovery(e),
    lastProofAt,
    removedSubjectState: e.subject?.state ?? null,
    subjectCount: e.subjects?.length ?? 0,
    subjectsTruncated: e.subjectsTruncated === true,
  };
}

/** Digest the evidence column of a row selected with EVIDENCE_DIGEST_SELECT. */
export function evidenceDigestOf(row: { [K in keyof typeof EVIDENCE_DIGEST_SELECT]?: unknown }): ResolutionEvidenceDigest | null {
  return digestStoredEvidence(row.resolutionEvidence);
}
