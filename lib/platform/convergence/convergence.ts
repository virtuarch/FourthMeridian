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
import { todayUTCISO } from "@/lib/time/clock";
import { db } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { loadRecentAlertRuns } from "@/lib/alerts/run";
import { incidentAccessors, type CsToken, type OpsToken } from "@/lib/platform/incidents/intelligence";
import { CONVERGENCE_PARTICIPANTS, convergenceInstant, type ConvergenceReaders, type ConvergenceParticipant, type ConvergenceWindow } from "@/lib/platform/convergence/participants";
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
  /**
   * PB-1 R3 — the incident audience token the ROUTE minted from its own guard
   * result. Sync-issue events are read only through the intelligence module,
   * which refuses a missing or forged token (fail closed).
   */
  incidentToken?: OpsToken | CsToken;
}
export interface ConvergenceDeps {
  now?: Date;
  readers?: ConvergenceReaders;
  participants?: readonly ConvergenceParticipant[];
}

// REVIEW-3 B-6 — the day formatter is THE clock seam's (lib/time/clock.ts).
const todayISO = (now: Date): string => todayUTCISO(now);
function minusDaysISO(iso: string, d: number): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) - d * 86_400_000).toISOString().slice(0, 10);
}

// ── Pure correlation ──────────────────────────────────────────────────────────────

/**
 * Cluster chronologically-sorted events into episodes. Pure.
 *
 * PRE-V26-PLAID-CLOSE Phase 4 — correlation is now SEMANTIC first, temporal
 * second. Time proximity alone merged unrelated incidents: a Chase sync run and
 * an Amex sync run an hour apart became one "episode", while one real incident
 * spanning a long retry gap split into several.
 *
 * The rule:
 *   • An event carrying a `correlationKey` clusters with events sharing that
 *     key, and with NOTHING else. For sync issues the key is item-scoped
 *     (`plaidItem:<id>|run:<runId>`), so an episode can never span two
 *     PlaidItems — including the `run:legacy` fallback for pre-Phase-4 rows,
 *     which still carries its own item id.
 *   • Events with NO key (jobs, alerts, status transitions — ledgers with no
 *     natural operational key) keep the original 6-hour proximity clustering.
 */
export function correlateEpisodes(events: readonly ConvergenceEvent[]): ConvergenceEpisode[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));

  // Keyed events: one cluster per key, in first-seen order.
  const keyed = new Map<string, ConvergenceEvent[]>();
  const unkeyed: ConvergenceEvent[] = [];
  for (const e of sorted) {
    if (e.correlationKey) {
      const bucket = keyed.get(e.correlationKey);
      if (bucket) bucket.push(e);
      else keyed.set(e.correlationKey, [e]);
    } else {
      unkeyed.push(e);
    }
  }

  const clusters: ConvergenceEvent[][] = [];
  if (unkeyed.length > 0) {
    let current: ConvergenceEvent[] = [unkeyed[0]];
    for (let i = 1; i < unkeyed.length; i++) {
      const gap = Date.parse(unkeyed[i].at) - Date.parse(unkeyed[i - 1].at);
      if (gap > EPISODE_GAP_MS) { clusters.push(current); current = []; }
      current.push(unkeyed[i]);
    }
    clusters.push(current);
  }
  clusters.push(...keyed.values());

  // Chronological episode order regardless of which bucket produced them.
  clusters.sort((a, b) => a[0].at.localeCompare(b[0].at));
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

function realReaders(now: Date, incidentToken: OpsToken | CsToken | undefined): ConvergenceReaders {
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
      // PB-1 Phase 2 (R3) — through the ONE intelligence module (Platform Ops tier,
      // identity-free), never SyncIssue directly. D6: an OPEN incident is in every
      // window whatever its creation date; a closed row only when it sits in it.
      if (!incidentToken) throw new Error("convergence: sync-issue events need an incident audience token (fail closed)");
      const { items: verdicts } = await incidentAccessors.window(incidentToken, { from, to });
      const rows = verdicts.filter((v) => {
        const open = v.rowClass === "incident" && v.state !== "resolved" && v.state !== "archived";
        if (open) return true;
        const at = Date.parse(convergenceInstant(v));
        return at >= from.getTime() && at <= to.getTime();
      });
      if (rows.length === 0) return [];

      // ONE batched lookup for operator-safe labels, rather than a query per row.
      const itemIds = [...new Set(rows.map((r) => r.plaidItemId).filter((v): v is string => v !== null))];
      const acctIds = [...new Set(rows.map((r) => r.financialAccountId).filter((v): v is string => v !== null))];
      const [items, accounts] = await Promise.all([
        itemIds.length
          ? db.plaidItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, institutionName: true } })
          : Promise.resolve([]),
        acctIds.length
          ? db.financialAccount.findMany({ where: { id: { in: acctIds } }, select: { id: true, institution: true } })
          : Promise.resolve([]),
      ]);
      const itemById = new Map(items.map((i) => [i.id, i.institutionName]));
      // PLATFORM OPS PRIVACY — the operator label is the institution, or an
      // opaque account reference. The customer's own account NAME is customer
      // data and never crosses into an operator payload.
      const acctById = new Map(accounts.map((a) => [a.id, a.institution ?? `Account …${a.id.slice(-6)}`]));

      return rows.map((v) => ({
        id: v.id, provider: v.provider, kind: v.kind, plaidItemId: v.plaidItemId, financialAccountId: v.financialAccountId,
        rowClass: v.rowClass, state: v.state, closure: v.closure, severity: v.severity, domain: v.domain,
        operation: v.operation, episodeKey: v.episodeKey,
        firstSeenAt: v.firstSeenAt, lastSeenAt: v.lastSeenAt, resolvedAt: v.resolvedAt,
        subjectLabel:
          (v.plaidItemId ? itemById.get(v.plaidItemId) : undefined)
          ?? (v.financialAccountId ? acctById.get(v.financialAccountId) : undefined)
          ?? null,
      }));
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
    async lifecycleEvents(from, to) {
      const rows = await db.auditLog.findMany({
        where: {
          action: { in: [
            AuditAction.BETA_ACCESS_APPROVED, AuditAction.BETA_ACCESS_DENIED, AuditAction.BETA_ACCESS_REDEEMED,
            AuditAction.ACCOUNT_DEACTIVATED, AuditAction.ACCOUNT_REACTIVATED,
            // PRE-BETA-OPS-CLOSE Phase 3 — provider-revocation evidence. These
            // rows SURVIVE the user deletion they describe (AuditLog.userId is
            // SetNull), which is exactly why they belong on an operator surface:
            // after the User is gone they are the only remaining record that an
            // upstream Plaid consent was never confirmed revoked.
            AuditAction.ACCOUNT_DELETION_REVOCATION_FAILED,
            AuditAction.ACCOUNT_DELETED_UNREVOKED,
          ] },
          createdAt: { gte: from, lte: to },
        },
        orderBy: { createdAt: "asc" },
        select: { action: true, createdAt: true },
      });
      return rows.map((r) => ({ at: r.createdAt, action: r.action }));
    },
  };
}

/** Cap on the flat timeline feed (the episodes carry the full clustered detail). */
const TIMELINE_CAP = 100;

// ── The authority ─────────────────────────────────────────────────────────────────

export async function getConvergence(args: ConvergenceArgs = {}, deps: ConvergenceDeps = {}): Promise<ConvergenceResult> {
  const now = deps.now ?? new Date();
  const readers = deps.readers ?? realReaders(now, args.incidentToken);
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

  // The flat timeline feed — the SAME events, un-clustered, newest-first, capped.
  const timeline = [...events].sort((a, b) => b.at.localeCompare(a.at)).slice(0, TIMELINE_CAP);

  return {
    window,
    episodes: correlateEpisodes(events),
    events: timeline,
    eventCount: events.length,
    participants: [...participated],
    checkedAt: now.toISOString(),
  };
}
