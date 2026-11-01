/**
 * lib/platform/operations/registry.ts  (OPS-5 S4 — Manual Operations)
 *
 * THE future-safe command registry for platform manual operations. It answers
 * two questions and NOTHING about execution:
 *   1. What KINDS of operation does the platform understand? (the vocabulary —
 *      run-now · refresh · retry · backfill · dry-run · invalidate)
 *   2. Which concrete (kind × target-job) COMMANDS are registered today?
 *
 * DOCTRINE — never a second execution path (mission requirement):
 *   A command does NOT carry its own job logic. A "run-now" command names a
 *   `SCHEDULED_JOBS` entry (lib/jobs/registry.ts); the engine resolves that
 *   entry's *exact* `run` closure (resolveJobBody) and runs it through
 *   `runJob(trigger:"manual")`. So a manual run executes the byte-identical
 *   body the dispatcher runs on a cron tick, and lands its own JobRun row in
 *   the same append-only ledger — observable in Job Health exactly like a cron
 *   run. There is one execution path (runJob), one job body per job, one
 *   ledger. This module is pure data + pure lookups: no I/O, no runJob, no db.
 *
 * FUTURE-SAFE, NOT OVER-BUILT (see PLATOPS_OBSERVABILITY_INVESTIGATION §5):
 *   All six operation KINDS are typed and documented here — the taxonomy is
 *   complete, so a future operation "registers cleanly" (add a kind entry
 *   and/or list it on a target). But only the kinds with a real canonical body
 *   AND a safe profile TODAY are `status:"active"` and materialize into
 *   commands: run-now and dry-run. refresh/retry/backfill/invalidate are
 *   `status:"reserved"` — present in the vocabulary with the precise reason
 *   they are not yet wired and what unblocks them. This is deliberate: the
 *   investigation ships "Run Now for FX first, keep destructive automatic-only"
 *   and defers backfill/invalidate — reserving them (rather than faking
 *   duplicate buttons) is the honest expression of that.
 *
 * TARGET SELECTION (safety, per investigation §5 candidate table):
 *   Only idempotent, safe-to-re-run, non-destructive job bodies are registered
 *   as targets — fetch-fx-rates, fetch-security-prices, sync-crypto. Explicitly
 *   NOT registered (and why) is pinned in EXCLUDED_TARGETS below and ratcheted
 *   by registry.test.ts, so a later hand can't casually expose a destructive or
 *   cooldown-bearing job without tripping the guard.
 */

import { SCHEDULED_JOBS } from "@/lib/jobs/registry";

// ── The operation-kind vocabulary (future-safe taxonomy) ──────────────────────

/** Every operation the platform's command registry can express. */
export type OperationKind =
  | "run-now"
  | "refresh"
  | "retry"
  | "backfill"
  | "dry-run"
  | "invalidate";

export interface OperationKindMeta {
  kind: OperationKind;
  /** Operator-facing verb, e.g. "Run Now". */
  label: string;
  /** One-line semantics. */
  description: string;
  /** Does invoking this kind write data / have side effects? dry-run = false. */
  mutates: boolean;
  /** Baseline confirmation weight — a destructive kind always confirms + WRITE. */
  destructive: boolean;
  /**
   * "active"   — wired to a canonical body; may be registered on a target now.
   * "reserved" — vocabulary only; register once its canonical body/params exist.
   */
  status: "active" | "reserved";
  /** For reserved kinds: why it isn't wired yet + what unblocks it. */
  reservedReason?: string;
}

/**
 * The complete kind registry. Typed `Record<OperationKind, …>` so the compiler
 * REQUIRES every kind to be described — a new kind cannot be added to the union
 * without documenting it here (the exhaustiveness idiom from PLATFORM_AREAS).
 */
export const OPERATION_KINDS: Record<OperationKind, OperationKindMeta> = {
  "run-now": {
    kind: "run-now",
    label: "Run Now",
    description:
      'Execute the job\'s canonical body immediately through runJob(trigger:"manual") — the same body the dispatcher runs, recorded as its own manual JobRun.',
    mutates: true,
    destructive: false,
    status: "active",
  },
  "dry-run": {
    kind: "dry-run",
    label: "Dry Run",
    description:
      "Preflight only — reports what a Run Now would do (target body, in-flight lock) WITHOUT executing. Writes no JobRun and touches no data.",
    mutates: false,
    destructive: false,
    status: "active",
  },
  refresh: {
    kind: "refresh",
    label: "Refresh",
    description:
      "Re-fetch external data now. For the idempotent fetch/sync jobs this is the SAME canonical execution as Run Now (skip-duplicates makes a re-fetch safe).",
    mutates: true,
    destructive: false,
    status: "reserved",
    reservedReason:
      "Semantic specialization of run-now for idempotent fetch jobs — served by run-now today (no second execution path). Promote to a distinct command only if a job ever needs a genuinely different refresh body.",
  },
  retry: {
    kind: "retry",
    label: "Retry",
    description:
      "Re-run after a failure. For idempotent job bodies this is identical execution to Run Now, surfaced when the last run failed.",
    mutates: true,
    destructive: false,
    status: "reserved",
    reservedReason:
      "Same canonical body as run-now for idempotent jobs. A dedicated retry command awaits a job whose retry differs from a fresh run (e.g. resume-from-checkpoint).",
  },
  backfill: {
    kind: "backfill",
    label: "Backfill",
    description: "Run over a historical range rather than only the newest slice.",
    mutates: true,
    destructive: false,
    status: "reserved",
    reservedReason:
      "Needs a bounded range parameter + a canonical range body (scripts/backfill-fx-rates.ts is the candidate authority). Deferred as heavier/parameterized by PLATOPS_OBSERVABILITY §9.",
  },
  invalidate: {
    kind: "invalidate",
    label: "Invalidate",
    description: "Clear a cache / freshness marker so the next read recomputes.",
    mutates: true,
    destructive: true,
    status: "reserved",
    reservedReason:
      "No cache/freshness target owns an invalidation contract yet; register once one does (WRITE + explicit confirm — destructive).",
  },
};

/** The kinds that may be registered on a target today. */
export const ACTIVE_OPERATION_KINDS: OperationKind[] = (
  Object.values(OPERATION_KINDS).filter((k) => k.status === "active") as OperationKindMeta[]
).map((k) => k.kind);

// ── Targets (the job bodies safe to operate manually) ─────────────────────────

export interface OperationTarget {
  /** The SCHEDULED_JOBS name whose canonical body this target operates. */
  targetJob: string;
  /** Operator-facing name, e.g. "FX Rates". */
  label: string;
  /** What running it does + why it is safe to run manually. */
  description: string;
  /** Active kinds registered for this target (subset of ACTIVE_OPERATION_KINDS). */
  kinds: OperationKind[];
  /**
   * PLATFORM-SEC-1 (2026-10-30) — true when a run fans out per-customer provider
   * work across the WHOLE fleet (every bank item / every wallet). Such a run is
   * cost-bearing provider work at platform scale, so running it needs CONTROL and
   * a structured reason — the same bar as resuming ONE wallet's history
   * (connections/[id]/history-resume). Before this it needed only WRITE with no
   * reason (capability-classification "manual-operations", UNRESOLVED).
   */
  fleet?: true;
}

/**
 * The registered targets. Every entry is an idempotent, safe-to-re-run,
 * non-destructive job body — the investigation §5 "Run-Now candidate" set.
 * run-now + dry-run each; run-now reuses the SCHEDULED_JOBS body verbatim.
 */
export const OPERATION_TARGETS: readonly OperationTarget[] = [
  {
    targetJob: "fetch-fx-rates",
    label: "FX Rates",
    description:
      "Fetch yesterday's still-missing USD cross-rates. Insert-only (skip-duplicates), network-light, idempotent — the direct remedy for an empty/stale FxRate archive.",
    kinds: ["run-now", "dry-run"],
  },
  {
    targetJob: "fetch-security-prices",
    label: "Security Prices",
    description:
      "Fetch the daily historical security-price series. Idempotent; a no-op until a price vendor is keyed (vendor-gated).",
    kinds: ["run-now", "dry-run"],
  },
  {
    targetJob: "sync-crypto",
    fleet: true,
    label: "Crypto Wallets",
    description:
      "Refresh every syncable wallet (BTC, ETH, SOL, …) through the one wallet pipeline, oldest first, skipping wallets not yet due under the WALLET refresh policy; regenerate affected snapshots and history. Idempotent; never-throws per wallet.",
    kinds: ["run-now", "dry-run"],
  },
  {
    // OPS-6A Connection Operations — the operator's fleet Plaid sync/retry. The
    // fleet body syncs every active bank item, and EACH item runs under
    // withPlaidItemSyncLock (F1): an item already in flight (cron/webhook/manual)
    // is skipped-locked, not raced — so a manual sweep RESPECTS the same per-item
    // locks, which is exactly the condition the OPS-4 exclusion required (it now
    // leaves EXCLUDED_TARGETS consciously). Per-item failures are isolated; the
    // daily cron runs this identical body. Re-running it retries previously-failed
    // items. Skips deactivated users' items (billing honesty).
    targetJob: "sync-banks",
    fleet: true,
    label: "Bank Connections",
    description:
      "Sync transactions for every active Plaid bank connection (fleet). Each item runs under its per-item sync lock (skipped if a sync is already in flight), so this respects the same locks the cron and per-item refresh use; per-item failures are isolated. Idempotent; retries previously-failed connections.",
    kinds: ["run-now", "dry-run"],
  },
  {
    // OPERATIONALIZATION P0 — the alert evaluation as a lever. Vercel fires crons
    // on PRODUCTION deployments only, evaluate-alerts has no per-job fallback
    // route, and CRON_SECRET is held by nobody (generated and piped straight into
    // Vercel), so on Preview the alert path could never run at all — which means
    // a configured PLATFORM_ALERTS_EMAIL could not be PROVEN to deliver before
    // Production depended on it. The body is the OPS-5 S5 orchestrator verbatim:
    // reads three authorities, suppresses breaches already delivered within the
    // re-notify window (so a manual run after a cron run sends nothing twice),
    // never throws, and ledgers its summary exactly as a cron run does.
    targetJob: "evaluate-alerts",
    label: "Alert Evaluation",
    description:
      "Evaluate every live alert rule against the current job-health, connection-health, resource-freshness and AI-failure authorities and deliver any breach not already notified within the re-notify window to PLATFORM_ALERTS_EMAIL. Read-only over product data; writes one JobRun summary (the alert history). Idempotent; never throws.",
    kinds: ["run-now", "dry-run"],
  },
  {
    // Owner decision 2 (2026-10-28) — the background Solana history backfill as
    // a lever, for the same reason as evaluate-alerts: crons fire on Production
    // only, so on Preview it can run at all only from here. The body is the job
    // verbatim: OFF unless SOL_BACKFILL_ENABLED=true (a disabled run returns at
    // once and writes nothing), wake-aware, under each wallet's sync lock, rate-
    // and daily-cap-limited, checkpointed — a manual run is exactly one more run.
    targetJob: "sol-history-backfill",
    fleet: true,
    label: "Solana History Backfill",
    description:
      "Advance resumable Solana and Bitcoin wallet history (oldest-waiting wallets first) within each chain's rate limit, per-wallet budget and daily request cap; each wallet under its sync lock; progress is checkpointed. Does nothing unless SOL_BACKFILL_ENABLED=true (Bitcoin also off with BTC_BACKFILL_ENABLED=false). Idempotent; never-throws per wallet.",
    kinds: ["run-now", "dry-run"],
  },
];

/**
 * Registered SCHEDULED_JOBS deliberately NOT exposed as manual targets, with the
 * reason — the safety ratchet (registry.test.ts asserts none of these leaks into
 * OPERATION_TARGETS). A later hand adds a target here consciously, not by reflex.
 */
export const EXCLUDED_TARGETS: Record<string, string> = {
  // sync-banks GRADUATED to an OPERATION_TARGET in OPS-6A: the fleet body runs
  // every item under withPlaidItemSyncLock (F1), so a manual sweep respects the
  // per-item locks the OPS-4 exclusion required. See OPERATION_TARGETS above.
  "process-deletions":
    "Destructive (executes pending account/data deletions). Automatic-only; if ever exposed, requires WRITE + explicit typed confirm (investigation §5).",
  // W2 — the goals purge arm was deleted (Goals retired); since the pre-beta
  // remediation (PRIV-003/DB-001) the job body is the retention sweep
  // (trashed Spaces/accounts are not hard-purged: owner decision). No operator value to expose.
  "purge-trash":
    "Daily data-retention sweep (docs/operations/data-retention.md): prunes operational ledgers, revoked sessions, stale waitlist rows and old Briefs. Automatic-only (investigation §5).",
  "notification-cleanup": "Low operator value; no reason to expose (investigation §5 ➖).",
  "notification-retry": "Low operator value; the daily cadence is the retry mechanism (investigation §5 ➖).",
  "rate-limit-sweep": "Low operator value; automatic-only (investigation §5 ➖).",
  // Comms Center B2 — the automation executor SENDS customer messages; an operator
  // lever over it would be a send button. Activation (CONTROL + owner approval) is
  // the only way an automation reaches customers; the wake is its only executor.
  "comms-automations": "Sends customer messages for ACTIVE automations; automatic-only — activation (CONTROL + owner approval) is the operator lever.",
};

// ── Materialized commands (kind × target) ─────────────────────────────────────

export interface OperationCommand {
  /** Stable id "<kind>:<targetJob>" — the audit + API key; MUST never change. */
  id: string;
  kind: OperationKind;
  targetJob: string;
  /**
   * JobRun ledger name a Run Now records under — equal to targetJob, so the
   * manual run is visible in Job Health / freshness exactly like a cron run
   * (a manual FX run resets an "overdue" classification the same way).
   */
  jobName: string;
  /** The kind verb, e.g. "Run Now". */
  label: string;
  /** The target name, e.g. "FX Rates". */
  targetLabel: string;
  /** Target description (what the body does). */
  description: string;
  /** Non-mutating (dry-run) commands never execute. */
  mutates: boolean;
  destructive: boolean;
  /** Confirmation copy shown before a mutating execute. */
  confirm: string;
  /** What executing this command requires — read by the route (authority) and the widget (display). */
  requires: OperationRequirement;
}

export interface OperationRequirement {
  level: "WRITE" | "CONTROL";
  /** A structured operator reason ({ code, note? }) must accompany the request. */
  reason: boolean;
}

/**
 * PURE — the authority a command needs. A MUTATING run of a fleet target needs
 * CONTROL + reason; everything else (single-scope runs, and every dry run, which
 * executes nothing) needs WRITE and no reason.
 */
export function operationRequirement(mutates: boolean, fleet: boolean): OperationRequirement {
  return mutates && fleet ? { level: "CONTROL", reason: true } : { level: "WRITE", reason: false };
}

/** Stable command id. */
export function commandId(kind: OperationKind, targetJob: string): string {
  return `${kind}:${targetJob}`;
}

/** All registered commands = each target × its registered kinds. Pure. */
export function listOperationCommands(): OperationCommand[] {
  const out: OperationCommand[] = [];
  for (const t of OPERATION_TARGETS) {
    for (const kind of t.kinds) {
      const meta = OPERATION_KINDS[kind];
      out.push({
        id: commandId(kind, t.targetJob),
        kind,
        targetJob: t.targetJob,
        jobName: t.targetJob,
        label: meta.label,
        targetLabel: t.label,
        description: t.description,
        mutates: meta.mutates,
        destructive: meta.destructive,
        confirm: meta.mutates
          ? `Run "${t.label}" now? This executes the canonical job body immediately and records a manual JobRun.`
          : `Dry-run "${t.label}"? This only previews what a run would do — nothing executes.`,
        requires: operationRequirement(meta.mutates, t.fleet === true),
      });
    }
  }
  return out;
}

/** Look up a single command by id. Pure. */
export function getOperationCommand(id: string): OperationCommand | undefined {
  return listOperationCommands().find((c) => c.id === id);
}

/**
 * The canonical body for a target job, resolved from SCHEDULED_JOBS — the SAME
 * closure the dispatcher runs (never a copy). Throws if the target is not a
 * registered job (a registry drift the ratchet test forbids).
 */
export function resolveJobBody(targetJob: string): () => Promise<unknown> {
  const job = SCHEDULED_JOBS.find((j) => j.name === targetJob);
  if (!job) {
    throw new Error(`operations: target job "${targetJob}" is not in SCHEDULED_JOBS`);
  }
  return job.run;
}
