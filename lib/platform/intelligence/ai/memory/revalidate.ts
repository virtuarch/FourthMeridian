/**
 * lib/platform/intelligence/ai/memory/revalidate.ts  (Platform AI operational memory — the live re-check)
 *
 * Design v2 §2 "Revalidate" (D9). PURE over injected readers: every ref of a
 * fact is re-read through the CURRENT binding or authorized reader (built by
 * the route from the operator's FRESH guard on the fact's area — never from the
 * stored row), and the fact gets ONE result:
 *
 *   UNCHANGED   every ref still reads the state it had at creation
 *   CHANGED     a ref's state differs: { was, now } (the first changed ref)
 *   UPDATED     same state, but the record was edited since (updatedAt > observedAt)
 *   GONE        a ref is deleted, or not visible to the operator any more
 *   UNVERIFIED  a read timed out or errored (the 2 s budget) — never phrased as current
 *
 * Precedence: GONE > CHANGED > UNVERIFIED > UPDATED > UNCHANGED. The live
 * SUBJECT LABEL comes from the same read (never stored text); a GONE fact has
 * no label. Memory reads never write anything here (./retrieve.ts applies the
 * B3 rule and invalidates through the store).
 */

import { MEMORY_REVALIDATE_BUDGET_MS, type MemoryObservedState } from "./constants";
import { incidentObservedState, jobObservedState, metricObservedState, providerObservedState, type MemoryRef } from "./schema";

export type CheckStatus = "UNCHANGED" | "CHANGED" | "UPDATED" | "GONE" | "UNVERIFIED";

/** What one reader returns for one ref (null = gone / not visible). */
export interface RecordRead { state: MemoryObservedState; label: string; updatedAt: Date | null }

/**
 * The authorized readers for ONE area, built by the route from its fresh guard.
 * Each returns null for a record that is gone or not visible to the operator.
 */
export interface MemoryReaders {
  metric(id: string, window: number | undefined): Promise<RecordRead | null>;
  page(id: string): Promise<RecordRead | null>;
  incident(id: string): Promise<RecordRead | null>;
  job(name: string): Promise<RecordRead | null>;
  provider(key: string): Promise<RecordRead | null>;
}

export interface RefCheck { ref: MemoryRef; status: CheckStatus; now: MemoryObservedState | null; label: string | null }

export interface FactCheck {
  status: CheckStatus;
  /** CHANGED only: the state at creation and the live state. */
  was: MemoryObservedState | null;
  now: MemoryObservedState | null;
  /** The live subject label (first ref); null when GONE or unverified. */
  label: string | null;
  /** The refs with their CURRENT observed states (renew writes these). */
  currentRefs: MemoryRef[];
  refs: RefCheck[];
}

async function readRef(ref: MemoryRef, r: MemoryReaders): Promise<RecordRead | null> {
  switch (ref.t) {
    case "METRIC": return r.metric(ref.id, ref.w);
    case "PAGE": return r.page(ref.id);
    case "INCIDENT": return r.incident(ref.id);
    case "JOB": return r.job(ref.id);
    case "PROVIDER": return r.provider(ref.id);
  }
}

async function checkRef(ref: MemoryRef, observedAt: Date, r: MemoryReaders): Promise<RefCheck> {
  try {
    const live = await readRef(ref, r);
    if (!live) return { ref, status: "GONE", now: null, label: null };
    if (live.state !== ref.observedState) return { ref, status: "CHANGED", now: live.state, label: live.label };
    if (live.updatedAt && live.updatedAt.getTime() > observedAt.getTime()) return { ref, status: "UPDATED", now: live.state, label: live.label };
    return { ref, status: "UNCHANGED", now: live.state, label: live.label };
  } catch {
    return { ref, status: "UNVERIFIED", now: null, label: null };
  }
}

const RANK: Record<CheckStatus, number> = { GONE: 4, CHANGED: 3, UNVERIFIED: 2, UPDATED: 1, UNCHANGED: 0 };

/** Combine ref checks into the fact's result. */
export function combineChecks(refs: readonly RefCheck[]): FactCheck {
  const worst = refs.reduce<CheckStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), "UNCHANGED");
  const changed = refs.find((c) => c.status === "CHANGED") ?? null;
  return {
    status: worst,
    was: worst === "CHANGED" && changed ? changed.ref.observedState : null,
    now: worst === "CHANGED" && changed ? changed.now : null,
    label: worst === "GONE" ? null : refs.find((c) => c.label !== null)?.label ?? null,
    currentRefs: refs.map((c) => ({ ...c.ref, observedState: c.now ?? c.ref.observedState })),
    refs: [...refs],
  };
}

/** Re-check ONE fact (all refs in parallel). A fact with no refs (a preference) is UNCHANGED. */
export async function revalidateFact(fact: { refs: readonly MemoryRef[]; observedAt: Date }, readers: MemoryReaders): Promise<FactCheck> {
  return combineChecks(await Promise.all(fact.refs.map((ref) => checkRef(ref, fact.observedAt, readers))));
}

const UNVERIFIED_OF = (refs: readonly MemoryRef[]): FactCheck =>
  combineChecks(refs.map((ref) => ({ ref, status: "UNVERIFIED" as const, now: null, label: null })));

/**
 * Re-check many facts under ONE budget (D9: 2 s). A fact whose check has not
 * settled by the deadline is UNVERIFIED (its read keeps running; its answer is
 * ignored). Never throws.
 */
export async function revalidateFacts<F extends { id: string; refs: readonly MemoryRef[]; observedAt: Date }>(
  facts: readonly F[], readers: MemoryReaders, budgetMs = MEMORY_REVALIDATE_BUDGET_MS,
): Promise<Map<string, FactCheck>> {
  const out = new Map<string, FactCheck>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"TIMEOUT">((res) => { timer = setTimeout(() => res("TIMEOUT"), budgetMs); });
  await Promise.all(facts.map(async (f) => {
    const r = await Promise.race([revalidateFact(f, readers).catch(() => UNVERIFIED_OF(f.refs)), deadline]);
    out.set(f.id, r === "TIMEOUT" ? UNVERIFIED_OF(f.refs) : r);
  }));
  if (timer) clearTimeout(timer);
  return out;
}

// ── Reader adapters (each reader's status → the closed state list) ───────────

/** A metric envelope → a RecordRead (no updatedAt: a figure is never "edited"). */
export const metricRead = (e: { status: string; subjects?: readonly { state: string }[] | null } | null, label: string): RecordRead | null =>
  e ? { state: metricObservedState(e), label, updatedAt: null } : null;
/** An incident verdict → a RecordRead (updatedAt = lastSeenAt: new evidence since). */
export const incidentRead = (v: { state: string; label: string; lastSeenAt: string } | null): RecordRead | null =>
  v ? { state: incidentObservedState(v.state), label: v.label, updatedAt: new Date(v.lastSeenAt) } : null;
/** A scheduled job's health report → a RecordRead (updatedAt = the newest run's start). */
export const jobRead = (j: { job: string; lastRunStatus: string | null; lastStartedAt: Date | null } | null): RecordRead | null =>
  j ? { state: jobObservedState(j.lastRunStatus), label: j.job, updatedAt: j.lastStartedAt } : null;
/** A provider health card → a RecordRead. */
export const providerRead = (p: { label: string; trust: string } | null): RecordRead | null =>
  p ? { state: providerObservedState(p.trust), label: p.label, updatedAt: null } : null;
