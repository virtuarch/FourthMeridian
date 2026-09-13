/**
 * lib/platform/policies/refresh-policies.core.ts  (PLATFORM OPS POLICIES — Slice 1)
 *
 * THE POLICIES READ MODEL — four facts, kept apart, composed at read time.
 *
 *   DESIRED      the PlatformSetting row, or its absence. What was stored.
 *   EFFECTIVE    the resolved policy actually in force (refresh-policy.core.ts).
 *                Differs from DESIRED exactly when the row is unreadable.
 *   CAPABILITY   what the deployed scheduler can attempt, derived from the
 *                registry (scheduler-capability.ts). Never a promise.
 *   ACTUAL       what the latest recorded sweep says it ran under — the policy
 *                version the job stamped into its JobRun summary. Evidence, or
 *                an honest UNKNOWN.
 *
 * Nothing here is persisted; there is no second policy store. This is the
 * authority the future editor consumes: the same descriptor, the same
 * capability, the same version. Pure — no Prisma, no clock but `now`.
 *
 * ⚠️ AN INVALID OVERRIDE IS NEVER PRESENTED AS CONFIGURED. When origin is
 * INVALID_SETTING the view says the default is in force AND that a stored
 * override exists and is unreadable. Reading never repairs the row.
 */

import type { RefreshSchedulerCapability } from "@/lib/platform/scheduler-capability";
import {
  GRACE_FLOOR_HOURS, GRACE_SHARE, cadenceHours, resolveRefreshPolicy, schedulerCanHonour,
  type RefreshCadence, type RefreshPolicy, type RefreshSourceKind,
} from "@/lib/platform/refresh-policy.core";

// ── Inputs ────────────────────────────────────────────────────────────────────

/** The setting row as stored — value, provenance clock, and who last wrote it. */
export interface RefreshSettingRowFacts {
  value: string;
  updatedAt: Date;
  updatedById: string | null;
}

/** The newest completed run of a job bound to the source kind, and the policy version it stamped. */
export interface RefreshExecutionEvidence {
  job: string;
  startedAt: Date;
  /** `JobRun.summary.policy.version` when the job records one; null otherwise. */
  policyVersion: string | null;
}

// ── The view ──────────────────────────────────────────────────────────────────

export interface RefreshPolicyDesired {
  /** True when an override row exists (readable or not). */
  present: boolean;
  /** The stored string, verbatim, when a row exists. */
  raw: string | null;
  /** The row's provenance clock — the future editor's concurrency token. Null without a row. */
  updatedAt: string | null;
  /** Who last wrote the row, when resolvable. Never an email. */
  updatedBy: { id: string; name: string | null } | null;
}

export interface RefreshPolicyEffective {
  cadence: RefreshCadence;
  expectedEveryHours: number;
  graceHours: number;
  overdueAfterHours: number;
  origin: RefreshPolicy["origin"];
  version: string;
}

export type RefreshPolicyActualState = "CURRENT" | "PENDING" | "UNKNOWN";

export interface RefreshPolicyActual {
  state: RefreshPolicyActualState;
  /** The version the latest recorded run stamped; null when none. */
  observedVersion: string | null;
  observedAt: string | null;
  job: string | null;
  /** One sentence saying what the evidence supports. */
  note: string;
}

export interface RefreshPolicyCapabilityView extends RefreshSchedulerCapability {
  /** Whether the EFFECTIVE cadence is one the schedule can deliver exactly. */
  effectiveHonoured: boolean;
}

export type RefreshPolicyMismatch =
  | { kind: "INVALID_OVERRIDE"; message: string }
  | { kind: "UNHONOURABLE_EFFECTIVE"; message: string };

export interface RefreshPolicyView {
  sourceKind: RefreshSourceKind;
  label: string;
  description: string;
  desired: RefreshPolicyDesired;
  effective: RefreshPolicyEffective;
  capability: RefreshPolicyCapabilityView;
  actual: RefreshPolicyActual;
  /** Where desired, effective and capability disagree. Null when they agree. */
  mismatch: RefreshPolicyMismatch | null;
}

export interface RefreshPoliciesReadModel {
  checkedAt: string;
  /** The code-owned grace rule, stated once so the UI never restates it. */
  grace: { floorHours: number; share: number };
  policies: RefreshPolicyView[];
}

// ── Composition ───────────────────────────────────────────────────────────────

export interface ComposeRefreshPolicyInput {
  sourceKind: RefreshSourceKind;
  label: string;
  description: string;
  row: RefreshSettingRowFacts | null;
  /** Display name for `row.updatedById`, when the loader resolved one. */
  updatedByName: string | null;
  capability: RefreshSchedulerCapability;
  evidence: RefreshExecutionEvidence | null;
}

function actualFrom(
  evidence: RefreshExecutionEvidence | null,
  effective: RefreshPolicyEffective,
  capability: RefreshSchedulerCapability,
): RefreshPolicyActual {
  if (capability.primaryJobs.length === 0) {
    return { state: "UNKNOWN", observedVersion: null, observedAt: null, job: null,
      note: "No scheduled job refreshes this source, so there is no execution to observe." };
  }
  if (!evidence) {
    return { state: "UNKNOWN", observedVersion: null, observedAt: null, job: null,
      note: `No completed ${capability.primaryJobs.join(" / ")} run is recorded, so which policy last executed is unknown.` };
  }
  const at = evidence.startedAt.toISOString();
  if (evidence.policyVersion === null) {
    return { state: "UNKNOWN", observedVersion: null, observedAt: at, job: evidence.job,
      note: `The latest ${evidence.job} run recorded no policy version; the ledger cannot say which policy it ran under.` };
  }
  if (evidence.policyVersion === effective.version) {
    return { state: "CURRENT", observedVersion: evidence.policyVersion, observedAt: at, job: evidence.job,
      note: `The latest ${evidence.job} run executed under the policy now in force.` };
  }
  return { state: "PENDING", observedVersion: evidence.policyVersion, observedAt: at, job: evidence.job,
    note: `The latest ${evidence.job} run executed under an earlier policy; the current one applies at the next scheduled attempt.` };
}

/** Compose one source kind's view. Pure. */
export function composeRefreshPolicyView(input: ComposeRefreshPolicyInput): RefreshPolicyView {
  const { sourceKind, row, capability } = input;
  const policy = resolveRefreshPolicy({ sourceKind }, row);
  const effective: RefreshPolicyEffective = {
    cadence: policy.cadence,
    expectedEveryHours: policy.expectedEveryHours,
    graceHours: policy.graceHours,
    overdueAfterHours: policy.overdueAfterHours,
    origin: policy.origin,
    version: policy.version,
  };
  const desired: RefreshPolicyDesired = {
    present: row !== null,
    raw: row?.value ?? null,
    updatedAt: row ? row.updatedAt.toISOString() : null,
    updatedBy: row?.updatedById ? { id: row.updatedById, name: input.updatedByName } : null,
  };
  const effectiveHonoured = schedulerCanHonour(policy.cadence, capability.attemptPeriodHours);

  let mismatch: RefreshPolicyMismatch | null = null;
  if (policy.origin === "INVALID_SETTING") {
    mismatch = { kind: "INVALID_OVERRIDE",
      message: `The stored override "${row?.value ?? ""}" is unreadable; the default of ${cadenceHours(policy.cadence)} hours is in force.` };
  } else if (!effectiveHonoured) {
    const reason = capability.options.find((o) => o.cadence === policy.cadence)?.reason ?? "The deployed scheduler cannot honour this cadence.";
    mismatch = { kind: "UNHONOURABLE_EFFECTIVE", message: reason };
  }

  return {
    sourceKind,
    label: input.label,
    description: input.description,
    desired,
    effective,
    capability: { ...capability, effectiveHonoured },
    actual: actualFrom(input.evidence, effective, capability),
    mismatch,
  };
}

/** Compose the whole read model from per-kind inputs. Pure. */
export function composeRefreshPoliciesReadModel(
  inputs: readonly ComposeRefreshPolicyInput[],
  now: Date,
): RefreshPoliciesReadModel {
  return {
    checkedAt: now.toISOString(),
    grace: { floorHours: GRACE_FLOOR_HOURS, share: GRACE_SHARE },
    policies: inputs.map(composeRefreshPolicyView),
  };
}
