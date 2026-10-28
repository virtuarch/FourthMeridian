/**
 * lib/crypto/history-worker-schedule.core.ts
 *
 * PURE. How the background history worker (jobs/sol-history-backfill.ts)
 * shares one run's budget between its chains — SOL, BTC and ETH (2026-10-28).
 *
 * The defect this replaces: the passes ran in a FIXED order (SOL, then BTC,
 * then ETH) with ETH taking the remainder, while an ETH step needs
 * ETH_BACKFILL_START_RESERVE_MS (75 s) to start. After any SOL or BTC pass a
 * 120 s run never had 75 s left, so a Solana or Bitcoin backlog froze ALL
 * Ethereum history, run after run (observed on Preview: ETH JOB_BUDGET,
 * walletsRun 0, every run).
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 *   1. ROTATION. Each run has an ordinal (`rotation`), one more than the
 *      previous run's — persisted in the job's own JobRun summary, and counting
 *      runs that were killed before writing one (nextRotation). The chain at
 *      `rotation mod 3` of [SOL, BTC, ETH] LEADS: it runs first; the others
 *      follow in cyclic order. Chains without work are skipped.
 *   2. A PHASE IS AT LEAST A STEP. Each phase plans to a fair share of what is
 *      left (left ÷ chains still to run), raised to what the chain needs to
 *      START a step (its start reserve + PHASE_SETUP_MS) — never past the job
 *      deadline. The last phase gets everything left. A chain that finishes
 *      early hands its time on.
 *
 * ── The bound ────────────────────────────────────────────────────────────────
 * Every chain leads once in any 3 consecutive runs whose leader could start
 * (killed runs included), and a leader's phase is ≥ its need — so with
 * the defaults (120 s budget, ETH need 77 s) every chain with eligible work
 * starts ≥ 1 step within 3 runs, whatever the other chains' backlogs. A phase
 * deadline never exceeds the job deadline, which never exceeds the wake's safe
 * point (WAKE_SAFE_MS), and each phase still holds the regeneration and
 * price-gap reserves before starting a regeneration (unchanged).
 *
 * The ETH need is NOT lowered: an ETH step STOPS on its deadline (the
 * acquisition checks the clock before every probe batch), and a clock stop
 * that closes no chunk halves the chunk — so a step must be given the time
 * its probes need. Its 75 s start reserve covers a full default step (1,500
 * probes ≈ 60 s); the step gets its whole phase (no regeneration reserve) and
 * plans only the probes that time proves (stepProbeBudget). The scheduler
 * gives it that time on its turn.
 *
 * A chain whose FIRST item is a pending regeneration needs the regeneration
 * reserve (60 s; Solana with price gaps 75 s) instead, or the marker could
 * never clear under backlog. A leader whose phase cannot hold its first item
 * (a short wake) KEEPS the lead: the run records `leaderShort` and the next
 * run does not advance the rotation.
 *
 * Single chain: one phase, the whole budget (unchanged). Rotation 0 (no
 * persisted state) is the old order SOL → BTC → ETH with the old shares.
 */

export type HistoryChain = "SOL" | "BTC" | "ETH";
export const HISTORY_CHAINS: readonly HistoryChain[] = ["SOL", "BTC", "ETH"];

/** Slack on top of a chain's start reserve: the reads a pass makes before its first wallet. */
export const PHASE_SETUP_MS = 2_000;
/** Finished runs read back to find the last persisted rotation. */
export const ROTATION_LOOKBACK_RUNS = 16;
/** Fallback rotation clock (no persisted rotation in the lookback): the dispatcher's 15-minute wake slot. */
export const ROTATION_SLOT_MS = 15 * 60_000;

/** What a run persists (JobRun.summary.schedule) for the next one. */
export interface HistoryWorkerSchedule {
  rotation: number;
  /** The chains with work this run, in the order they ran. */
  order: HistoryChain[];
  /** The leader's phase could not hold its first item (too little wake left): the next run keeps the lead. */
  leaderShort?: boolean;
}

/**
 * This run's rotation: the newest persisted rotation among the job's previous
 * FINISHED runs (newest first), plus one — none when that run's leader could
 * not start (`leaderShort`: it keeps the lead) — plus one for each run since,
 * so a run killed before its summary was written still advanced the rotation
 * (it was killed mid-pass, so its leader started). No run yet ⇒ 0;
 * none persisted in the lookback ⇒ `fallback` (the wake slot), which still
 * advances run to run.
 */
export function nextRotation(previous: ReadonlyArray<{ summary: unknown }>, fallback: number): number {
  if (previous.length === 0) return 0; // the job's first run
  for (let i = 0; i < previous.length; i++) {
    const sch = (previous[i]?.summary as { schedule?: { rotation?: unknown; leaderShort?: unknown } } | null | undefined)?.schedule;
    const r = sch?.rotation;
    if (typeof r === "number" && Number.isSafeInteger(r) && r >= 0) return r + (sch?.leaderShort === true ? 0 : 1) + i;
  }
  return Math.max(0, Math.floor(fallback));
}

/** The chains with work, leader first, then cyclically. */
export function chainOrder(rotation: number, withWork: ReadonlySet<HistoryChain>): HistoryChain[] {
  const n = HISTORY_CHAINS.length;
  const k = ((Math.floor(rotation) % n) + n) % n;
  return [...HISTORY_CHAINS.slice(k), ...HISTORY_CHAINS.slice(0, k)].filter((c) => withWork.has(c));
}

/**
 * Where the phase starting at `nowMs` plans to. `chainsLeft` counts this chain
 * and those after it; `needMs` is what this chain needs to start one step.
 */
export function phaseDeadlineFor(args: { nowMs: number; jobDeadlineMs: number; chainsLeft: number; needMs: number }): number {
  const left = Math.max(0, args.jobDeadlineMs - args.nowMs);
  if (args.chainsLeft <= 1) return args.nowMs + left;
  const fair = Math.floor(left / args.chainsLeft);
  return args.nowMs + Math.min(left, Math.max(fair, Math.max(0, args.needMs)));
}
