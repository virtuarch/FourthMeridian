/**
 * lib/platform/scheduler-capability.ts  (PLATFORM OPS POLICIES — Slice 1 · P1 scheduling control)
 *
 * MAY THE PLATFORM EXECUTE THIS CADENCE? — the one binding of the pure rule
 * (refresh-policy.core.ts assessCadence) to the deployed facts.
 *
 * Until P1 the question was "can the deployed SLOT schedule deliver this cadence
 * exactly?" and the answer was derived from the registry's fire hours. The
 * dispatcher is now woken every WAKE_EVERY_MINUTES and judges due-ness from the
 * ledger and the stored cadence (lib/jobs/cadence-policy.core.ts), so every menu
 * cadence is deliverable to within a wake. What bounds the menu is the source
 * kind's code-owned FLOOR (REFRESH_CADENCE_FLOOR_HOURS) — provider and economic
 * safety — and whether any registered job refreshes the kind at all.
 *
 * Every consumer that needs the answer — the Policies read model, the setting
 * validator, job health — asks HERE. Reads the scheduling FACTS
 * (lib/jobs/registry.core.ts), never the executable registry: this module is on
 * the auth path (lib/auth.ts → platform-settings → here), PERF-1.
 */

import { SCHEDULED_JOB_FACTS } from "@/lib/jobs/registry.core";
import { refreshFamily, type SlotFacts } from "@/lib/jobs/cadence";
import { WAKE_EVERY_MINUTES } from "@/lib/jobs/cadence-policy.core";
import {
  REFRESH_CADENCES, REFRESH_CADENCE_FLOOR_HOURS, assessCadence,
  type CadenceAssessment, type RefreshCadence, type RefreshSourceKind,
} from "@/lib/platform/refresh-policy.core";

export interface RefreshSchedulerCapability {
  sourceKind: RefreshSourceKind;
  /** The safety floor for this kind, in hours. Null: no registered job refreshes it. */
  floorHours: number | null;
  /** How often the platform is woken to judge due work. Infrastructure cadence. */
  wakeEveryMinutes: number;
  /** The registry job(s) that ARE the opportunity, and the ones that finish deferred work. */
  primaryJobs: string[];
  continuationJobs: string[];
  /** The whole menu, each with its verdict and reason. */
  options: CadenceAssessment[];
  /** The honourable subset of the menu, in menu order. */
  honourable: RefreshCadence[];
}

const SOURCE_NOUN: Record<RefreshSourceKind, string> = { BANK: "bank", WALLET: "wallet" };

/** The floor for a kind — null when no registered job refreshes it (nothing could honour any cadence). */
export function floorHoursFor(sourceKind: RefreshSourceKind, jobs: readonly SlotFacts[] = SCHEDULED_JOB_FACTS): number | null {
  return refreshFamily(jobs, sourceKind).primary.length === 0 ? null : REFRESH_CADENCE_FLOOR_HOURS[sourceKind];
}

/** The platform's capability for one source kind. */
export function schedulerCapability(
  sourceKind: RefreshSourceKind,
  jobs: readonly SlotFacts[] = SCHEDULED_JOB_FACTS,
): RefreshSchedulerCapability {
  const floor = floorHoursFor(sourceKind, jobs);
  const family = refreshFamily(jobs, sourceKind);
  const options = REFRESH_CADENCES.map((c) => assessCadence(c, floor, SOURCE_NOUN[sourceKind]));
  return {
    sourceKind,
    floorHours: floor,
    wakeEveryMinutes: WAKE_EVERY_MINUTES,
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

/** Is `cadence` honourable for `sourceKind`? One answer, one place. */
export function cadenceIsHonourable(
  sourceKind: RefreshSourceKind,
  cadence: RefreshCadence,
  jobs: readonly SlotFacts[] = SCHEDULED_JOB_FACTS,
): CadenceAssessment {
  return assessCadence(cadence, floorHoursFor(sourceKind, jobs), SOURCE_NOUN[sourceKind]);
}
