/**
 * lib/platform/scheduler-capability.ts  (PLATFORM OPS POLICIES — Slice 1)
 *
 * CAN THE DEPLOYED SCHEDULER HONOUR THIS CADENCE? — the one binding of the pure
 * rule (refresh-policy.core.ts assessCadence) to the real registry.
 *
 * Every consumer that needs to know what the scheduler can attempt — the Policies
 * read model, the setting validator, job health — asks HERE. Nothing else may
 * hold a list of honourable cadences or an attempt period: they are derived from
 * SCHEDULED_JOBS (`refreshes` + fire slots, lib/jobs/cadence.ts) at call time,
 * and lib/jobs/cadence.test.ts pins that derivation to vercel.json.
 *
 * Import-light: the registry dynamic-imports its job bodies, so binding to it
 * costs nothing at module load and works in any credential-free context.
 */

import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
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
  jobs: readonly SlotFacts[] = SCHEDULED_JOBS,
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
  jobs: readonly SlotFacts[] = SCHEDULED_JOBS,
): Readonly<Record<RefreshSourceKind, RefreshSchedulerCapability>> {
  return { BANK: schedulerCapability("BANK", jobs), WALLET: schedulerCapability("WALLET", jobs) };
}

/** Is `cadence` honourable for `sourceKind` on the deployed schedule? One answer, one place. */
export function cadenceIsHonourable(
  sourceKind: RefreshSourceKind,
  cadence: RefreshCadence,
  jobs: readonly SlotFacts[] = SCHEDULED_JOBS,
): CadenceAssessment {
  return assessCadence(cadence, attemptPeriodHours(jobs, sourceKind), SOURCE_NOUN[sourceKind]);
}
