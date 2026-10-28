/**
 * lib/usage/provider-budget.core.ts
 *
 * PURE. The SHARED DAILY PROVIDER BUDGET (2026-10-28) — one durable request
 * counter per provider, which every history path that spends that provider's
 * key increments, and which the background worker's daily cap reads.
 *
 * ── Why the existing counter, not a new table ───────────────────────────────
 * ApiUsageCounter (provider, metric, unit, day) already IS a durable, race-safe
 * daily counter: lib/usage/record.ts upsert-increments it on its unique key,
 * the Platform Ops API-usage view already lists every provider in it, the
 * retention job already bounds it (90 days), and its RLS posture (fm_system
 * only, revoked from fm_app) is already in force. A new table would be a second
 * counter with a second RLS surface. So: provider "ALCHEMY", unit "calls",
 * metric "<network>:<method>" — one row per (network, method, UTC day).
 *
 * ── How the SOL checkpoint usage relates ────────────────────────────────────
 * Each Solana wallet's checkpoint still records the requests ITS backfill sent
 * today, at every commit (durable even for a run killed mid-flight). Those
 * requests are ALSO recorded here — so the checkpoint sum is a SUBSET of the
 * ledger, never an addition to it. The budget in force is therefore the MAX of
 * the two: the ledger when it has been flushed, the checkpoints when a run died
 * between its commit and its flush.
 *
 * Counted unit: one JSON-RPC CALL (a batch of 50 is 50) — what the provider
 * meters and rate-limits, and the unit the Solana cap has always counted.
 */

/** ApiUsageCounter.provider for every Alchemy-keyed request. */
export const ALCHEMY_USAGE_PROVIDER = "ALCHEMY";
/** ApiUsageCounter.unit for request counts (the vocabulary lib/usage/record.ts documents). */
export const USAGE_UNIT_CALLS = "calls";

/** The networks whose history paths meter into the shared budget. */
export const ALCHEMY_USAGE_NETWORK = { SOLANA: "solana", ETHEREUM: "ethereum" } as const;

/** Requests by method. The shape every transport meter already uses. */
export type RequestMeter = Record<string, number>;

/** Total requests in a meter (non-finite / negative entries ignored). */
export function meterTotal(meter: Readonly<RequestMeter>): number {
  let n = 0;
  for (const v of Object.values(meter)) if (Number.isFinite(v) && v > 0) n += v;
  return n;
}

/**
 * What `meter` holds beyond `flushed` — the part not yet recorded. Pure; the
 * caller advances `flushed` to `meter` after a successful record.
 */
export function meterDelta(meter: Readonly<RequestMeter>, flushed: Readonly<RequestMeter>): RequestMeter {
  const out: RequestMeter = {};
  for (const [k, v] of Object.entries(meter)) {
    const d = (Number.isFinite(v) ? v : 0) - (flushed[k] ?? 0);
    if (d > 0) out[k] = d;
  }
  return out;
}

/** `ApiUsageCounter.metric` for one request kind. */
export function usageMetric(network: string, method: string): string {
  return `${network}:${method}`;
}

/** Today's ledger calls for one provider, split at the Solana boundary. */
export interface LedgerCalls {
  /** Calls under `solana:*` metrics — the ones the SOL checkpoints also record. */
  solana: number;
  /** Every other metric (ETH history, …) — no checkpoint holds these. */
  other: number;
}

/** Sum ledger rows (metric, count) into the Solana / other split. */
export function splitLedgerCalls(rows: ReadonlyArray<{ metric: string; count: number }>): LedgerCalls {
  const out: LedgerCalls = { solana: 0, other: 0 };
  for (const r of rows) {
    const n = Number.isFinite(r.count) && r.count > 0 ? r.count : 0;
    if (r.metric.startsWith(`${ALCHEMY_USAGE_NETWORK.SOLANA}:`)) out.solana += n; else out.other += n;
  }
  return out;
}

/**
 * The budget already spent today:
 *
 *     ledger(non-Solana)  +  max(ledger(Solana), Σ SOL checkpoint usage)
 *
 * The SOL checkpoints are a SUBSET of the ledger's Solana metrics (every SOL
 * request is recorded in both), so the max avoids double counting them; the
 * other metrics have no checkpoint and are always added. A plain max over the
 * TOTAL would let a killed SOL run (checkpoints recorded, ledger not flushed)
 * hide under ETH calls — 3,000 ETH + 2,000 unflushed SOL must read 5,000, not
 * 3,000. An unreadable ledger (null) falls back to the checkpoints alone.
 */
export function effectiveDailyUsage(args: { ledger: LedgerCalls | null; checkpointCalls: number }): number {
  const pos = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const cps = pos(args.checkpointCalls);
  if (!args.ledger) return cps;
  return pos(args.ledger.other) + Math.max(pos(args.ledger.solana), cps);
}

/** "YYYY-MM-DD" → the counter's day bucket (UTC midnight). */
export function usageDayBucket(dayISO: string): Date {
  return new Date(`${dayISO}T00:00:00.000Z`);
}

// ── Crash-safe metering (2026-10-28) ────────────────────────────────────────

/** Flush a running meter once this many calls are unrecorded… */
export const METER_FLUSH_EVERY_CALLS = 50;
/** …or once a call arrives this long after the last flush. */
export const METER_FLUSH_EVERY_MS = 5_000;

/** Records `meter` beyond `flushed` and advances `flushed` (recordProviderMeter's contract). */
export type MeterRecorder = (meter: Readonly<RequestMeter>, flushed: RequestMeter) => Promise<void>;

export interface IncrementalMeter {
  /** The meter to hand to a transport. Counting a call may start a flush in the background. */
  meter: RequestMeter;
  /** What the recorder has been handed so far (advanced by it). */
  flushed: RequestMeter;
  /** Record everything not yet recorded (after any flush in flight). Never throws. */
  flush(): Promise<void>;
}

/**
 * A meter that reaches the durable ledger WHILE its run is still sending, so
 * a run killed mid-pass (a platform timeout, SIGKILL) has spent at most one
 * flush's worth of requests the daily cap never sees — not the whole pass.
 *
 * The transport keeps its plain `meter[k] = (meter[k] ?? 0) + 1`; the meter is
 * a Proxy whose setter starts a flush when METER_FLUSH_EVERY_CALLS calls are
 * unrecorded, or when a call arrives METER_FLUSH_EVERY_MS after the last flush.
 * One flush at a time (the recorder's delta against `flushed` is computed and
 * advanced by one writer only), so nothing is counted twice; a flush that
 * finishes with the threshold crossed again runs once more. Write overhead is
 * bounded: one recorder call per ≥ `everyCalls` calls or per ≥ `everyMs`.
 *
 * A kill loses at most the calls since the last COMPLETED flush: fewer than
 * `everyCalls` (plus those of one `everyMs` window and of a flush in flight).
 * A recorder that throws, or records nothing, never loops and never fails the
 * run (metering never fails a run).
 */
export function incrementalMeter(
  record: MeterRecorder,
  opts: { everyCalls?: number; everyMs?: number; now?: () => number } = {},
): IncrementalMeter {
  const everyCalls = Math.max(1, Math.floor(opts.everyCalls ?? METER_FLUSH_EVERY_CALLS));
  const everyMs = Math.max(0, opts.everyMs ?? METER_FLUSH_EVERY_MS);
  const now = opts.now ?? Date.now;
  const raw: RequestMeter = {};
  const flushed: RequestMeter = {};
  const unrecorded = () => meterTotal(meterDelta(raw, flushed));
  let lastAt = now();
  let force = false;
  let inFlight: Promise<void> | null = null;
  const due = () => {
    const u = unrecorded();
    return u > 0 && (force || u >= everyCalls || now() - lastAt >= everyMs);
  };
  const pump = (): Promise<void> => {
    if (!inFlight) {
      inFlight = (async () => {
        while (due()) {
          const before = meterTotal(flushed);
          lastAt = now();
          try { await record(raw, flushed); } catch { /* metering never fails a run */ }
          if (meterTotal(flushed) <= before) break; // the recorder recorded nothing: never spin
        }
      })().finally(() => { inFlight = null; });
    }
    return inFlight;
  };
  const meter = new Proxy(raw, {
    set(target, key, value) {
      (target as Record<string | symbol, unknown>)[key] = value;
      if (!inFlight && due()) void pump();
      return true;
    },
  });
  return {
    meter, flushed,
    async flush() {
      if (inFlight) await inFlight;
      force = true;
      try { await pump(); } finally { force = false; }
    },
  };
}
