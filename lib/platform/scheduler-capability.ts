/**
 * lib/platform/scheduler-capability.ts  (PLATFORM OPS POLICIES — Slice 1)
 *
 * CAN THE DEPLOYED SCHEDULER HONOUR THIS CADENCE? — the one binding of the pure
 * rule (refresh-policy.core.ts assessCadence) to the real registry.
 *
 * Every consumer that needs to know what the scheduler can attempt — the Policies
 * read model, the setting validator, job health — asks HERE. Nothing else may
 * hold a list of honourable cadences or an attempt period: they are derived from
 * SCHEDULED_JOB_FACTS (`refreshes` + fire slots, lib/jobs/cadence.ts) at call time,
 * and lib/jobs/cadence.test.ts pins that derivation to vercel.json.
 *
 * Reads the scheduling FACTS (lib/jobs/registry.core.ts), never the executable
 * registry: this module is on the auth path (lib/auth.ts → platform-settings →
 * here), and the executable registry's dynamic-imported job bodies are
 * compiled into every route that reaches it (PERF-1; 34e592c had pulled the
 * jobs tree and the Plaid SDK into every authenticated route this way).
 */

import { SCHEDULED_JOB_FACTS } from "@/lib/jobs/registry.core";
import { attemptPeriodHours, attemptSlotsUTC, refreshFamily, type SlotFacts } from "@/lib/jobs/cadence";
import {
  REFRESH_CADENCES, assessCadence,
  type CadenceAssessment, type RefreshCadence, type RefreshSourceKind,
} from "@/lib/platform/refresh-policy.core";

export interface RefreshSchedulerCapability {
  sourceKind: RefreshSourceKind;
  /** How often the schedule attempts this source kind. Null: nothing refreshes it. */
  attemptPeriodHours: number | null;
  /** The UTC slots at which attempts happen ("06:00", …). */
  attemptSlotsUTC: string[];
  /** The registry job(s) that ARE the opportunity, and the ones that finish deferred work. */
  primaryJobs: string[];
  continuationJobs: string[];
  /** The whole menu, each with its verdict and reason. */
  options: CadenceAssessment[];
  /** The honourable subset of the menu, in menu order. */
  honourable: RefreshCadence[];
}

const SOURCE_NOUN: Record<RefreshSourceKind, string> = { BANK: "bank", WALLET: "wallet" };

/** The deployed scheduler's capability for one source kind, from the registry. */
export function schedulerCapability(
  sourceKind: RefreshSourceKind,
  jobs: readonly SlotFacts[] = SCHEDULED_JOB_FACTS,
): RefreshSchedulerCapability {
  const period = attemptPeriodHours(jobs, sourceKind);
  const family = refreshFamily(jobs, sourceKind);
  const options = REFRESH_CADENCES.map((c) => assessCadence(c, period, SOURCE_NOUN[sourceKind]));
  return {
    sourceKind,
    attemptPeriodHours: period,
    attemptSlotsUTC: attemptSlotsUTC(jobs, sourceKind),
    primaryJobs: family.primary.map((j) => j.name),
    continuationJobs: family.continuations.map((j) => j.name),
    options,
    honourable: options.filter((o) => o.honourable).map((o) => o.cadence),
  };
}

/** Both source kinds at once. */
export function schedulerCapabilities(
  jobs: readonly SlotFacts[] = SCHEDULED_JOB_FACTS,
): Readonly<Record<RefreshSourceKind, RefreshSchedulerCapability>> {
  return { BANK: schedulerCapability("BANK", jobs), WALLET: schedulerCapability("WALLET", jobs) };
}

/** Is `cadence` honourable for `sourceKind` on the deployed schedule? One answer, one place. */
export function cadenceIsHonourable(
  sourceKind: RefreshSourceKind,
  cadence: RefreshCadence,
  jobs: readonly SlotFacts[] = SCHEDULED_JOB_FACTS,
): CadenceAssessment {
  return assessCadence(cadence, attemptPeriodHours(jobs, sourceKind), SOURCE_NOUN[sourceKind]);
}
