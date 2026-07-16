/**
 * lib/platform/convergence/convergence.ts  (OPS-5 S9)
 *
 * THE single convergence authority: `getConvergence`. It projects every
 * participant ledger into read-only ConvergenceEvents over a window, then a PURE
 * correlation engine clusters them (by time proximity) into operational
 * ConvergenceEpisodes with a derived narrative (what happened · caused ·
 * recovered · participated). It reads the ledgers; it never merges, replaces,
 * flattens, reinterprets, or persists them, and emits no new event.
 *
 * PURE CORE + INJECTED I/O: the correlation is pure over projected events; the
 * real db-backed readers are built here and replaced by fakes in tests.
 */

import "server-only";
import { db } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { loadRecentAlertRuns } from "@/lib/alerts/run";
import { CONVERGENCE_PARTICIPANTS, type ConvergenceReaders, type ConvergenceParticipant, type ConvergenceWindow } from "@/lib/platform/convergence/participants";
import { worstTier } from "@/lib/platform/history/sources";
import type { ConvergenceEvent, ConvergenceEpisode, ConvergenceResult } from "@/lib/platform/convergence/types";
import type { OperationalTier } from "@/lib/platform/history/types";

/** New episode when the gap from the previous event exceeds this (an incident cluster). */
const EPISODE_GAP_MS = 6 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 14;

export interface ConvergenceArgs {
  asOf?: string;                    // window end (YYYY-MM-DD), default today
  from?: string;                    // window start (YYYY-MM-DD), default asOf-14d
  participantIds?: readonly string[];
}
export interface ConvergenceDeps {
  now?: Date;
  readers?: ConvergenceReaders;
  participants?: readonly ConvergenceParticipant[];
}

function todayISO(now: Date): string { return now.toISOString().slice(0, 10); }
function minusDaysISO(iso: string, d: number): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) - d * 86_400_000).toISOString().slice(0, 10);
}

// ── Pure correlation ──────────────────────────────────────────────────────────────

/** Cluster chronologically-sorted events into episodes by time-gap. Pure. */
export function correlateEpisodes(events: readonly ConvergenceEvent[]): ConvergenceEpisode[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const clusters: ConvergenceEvent[][] = [];
  let current: ConvergenceEvent[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = Date.parse(sorted[i].at) - Date.parse(sorted[i - 1].at);
    if (gap > EPISODE_GAP_MS) { clusters.push(current); current = []; }
    current.push(sorted[i]);
  }
  clusters.push(current);
  return clusters.map((evts, i) => buildEpisode(evts, i));
}

function buildEpisode(events: ConvergenceEvent[], index: number): ConvergenceEpisode {
  const subjects = [...new Set(events.map((e) => e.subject).filter((s) => s !== "-"))];
  const participants = [...new Set(events.map((e) => e.ledger))];
  const failures = events.filter((e) => e.outcome === "failure" || e.outcome === "degraded");
  const recoveries = events.filter((e) => e.outcome === "recovery");
  const lead = failures[0] ?? events[0];

  // Narrative: what happened (the lead degraded/failure), what caused it (the
  // failure chain's subjects), what recovered (a recovery AFTER the lead failure).
  const happened = `${lead.detail} (${events.length} correlated event${events.length === 1 ? "" : "s"})`;
  const caused = failures.length > 0 ? `${failures.length} failure/degraded event(s) across ${participants.length} ledger(s): ${[...new Set(failures.map((f) => f.subject))].join(", ")}` : null;
  const recovery = recoveries.find((r) => r.at >= lead.at) ?? null;
  const recovered = recovery ? recovery.detail : null;

  const trust: OperationalTier = worstTier([...events.map((e) => e.tier), "derived"]); // narrative is derived

  return {
    id: `episode-${index}`,
    from: events[0].at,
    to: events[events.length - 1].at,
    title: subjects[0] ? `${subjects[0]} — ${lead.kind}` : lead.kind,
    subjects,
    participants,
    events,
    narrative: { happened, caused, recovered },
    trust,
  };
}

// ── Real db-backed readers (the ONLY I/O; a fake replaces this in tests) ─────────

function realReaders(now: Date): ConvergenceReaders {
  return {
    now,
    async jobRuns(from, to) {
      return db.jobRun.findMany({
        where: { startedAt: { gte: from, lte: to } },
        orderBy: { startedAt: "asc" },
        select: { jobName: true, startedAt: true, status: true, trigger: true, errorSummary: true },
      });
    },
    alertRuns: (limit) => loadRecentAlertRuns(limit),
    async syncIssues(from, to) {
      return db.syncIssue.findMany({
        where: { createdAt: { gte: from, lte: to } },
        orderBy: { createdAt: "asc" },
        select: { provider: true, kind: true, plaidItemId: true, createdAt: true },
      });
    },
    async statusTransitions(from, to) {
      const rows = await db.auditLog.findMany({
        where: {
          action: { in: [AuditAction.PLAID_ITEM_STATUS_CHANGED, AuditAction.WALLET_CONNECTION_STATUS_CHANGED] },
          createdAt: { gte: from, lte: to },
        },
        orderBy: { createdAt: "asc" },
        select: { action: true, createdAt: true, metadata: true },
      });
      return rows.map((r) => {
        const meta = (r.metadata ?? {}) as { plaidItemId?: string; connectionId?: string; to?: string };
        return {
          at: r.createdAt,
          subject: meta.plaidItemId ?? meta.connectionId ?? "-",
          to: meta.to ?? "?",
          source: r.action === AuditAction.PLAID_ITEM_STATUS_CHANGED ? "PLAID" : "WALLET",
        };
      });
    },
  };
}

// ── The authority ─────────────────────────────────────────────────────────────────

export async function getConvergence(args: ConvergenceArgs = {}, deps: ConvergenceDeps = {}): Promise<ConvergenceResult> {
  const now = deps.now ?? new Date();
  const readers = deps.readers ?? realReaders(now);
  const all = deps.participants ?? CONVERGENCE_PARTICIPANTS;
  const participants = args.participantIds ? all.filter((p) => args.participantIds!.includes(p.ledger)) : all;

  const to = args.asOf ?? todayISO(now);
  const from = args.from ?? minusDaysISO(to, DEFAULT_WINDOW_DAYS);
  const window: ConvergenceWindow = { from, to };

  const events: ConvergenceEvent[] = [];
  const participated = new Set<string>();
  for (const p of participants) {
    try {
      const evts = await p.project(readers, window);
      if (evts.length > 0) participated.add(p.ledger);
      events.push(...evts);
    } catch (e) {
      console.warn(`[convergence] participant "${p.ledger}" failed (non-fatal):`, e);
    }
  }

  return {
    window,
    episodes: correlateEpisodes(events),
    eventCount: events.length,
    participants: [...participated],
    checkedAt: now.toISOString(),
  };
}
