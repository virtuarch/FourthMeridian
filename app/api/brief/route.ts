/**
 * GET /api/brief
 *
 * Returns a BriefPayload for the Daily Brief page.
 *
 * D4 Slice 6 — Context Builder integration.
 * Financial data now flows exclusively through buildContext() / the AI Context
 * Builder. The route no longer queries SpaceAccountLink, SpaceSnapshot, or
 * any financial table directly.
 *
 * ── Space eligibility ─────────────────────────────────────────────────────────
 * Context is built for every Space where the user is OWNER, ADMIN, or MEMBER.
 * VIEWER Spaces are excluded — they contribute read-only access to shared data
 * but should not drive the user's personal financial brief.
 *
 * ── Aggregation model ────────────────────────────────────────────────────────
 * Each eligible Space assembles its own Context independently (via buildContext
 * with scopeHint='brief'). The brief then:
 *   - Uses the primary Space (PERSONAL or first eligible) for headline metrics
 *     (net worth, account health) to avoid double-counting shared accounts.
 *   - Aggregates signals from ALL eligible Spaces; signals from non-primary
 *     Spaces carry the Space name in their metadata for attribution.
 *   - Reports the total account count across all eligible Spaces.
 *
 * ── What is still queried directly ───────────────────────────────────────────
 * Non-financial tables only:
 *   db.user          — display name, lastBriefViewedAt
 *   db.spaceMember   — eligible Space membership enumeration
 *   db.spaceInvite   — pending invite count
 *   db.aiAdvice      — cached AI-generated advice text (AI output, not source data)
 */

import { NextResponse }       from "next/server";
import { db }                 from "@/lib/db";
import { requireUser }        from "@/lib/session";
import { SpaceMemberRole }    from "@prisma/client";
import {
  buildContext,
  FinanceDomains,
  SignalType,
} from "@/lib/ai";
import type {
  SpaceContext_AI,
  AccountsSectionData,
  SnapshotSectionData,
  TransactionsSummaryData,
  ContextSignal,
} from "@/lib/ai";
import type {
  BriefPayload,
  BriefSection,
  BriefItem,
  BriefTone,
  VisitState,
  FinancialMapData,
  TrackedAccount,
} from "@/lib/brief-types";

// ── Formatting helpers (unchanged) ────────────────────────────────────────────

function fmtCurrency(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtDelta(delta: number): string {
  const sign = delta >= 0 ? "+" : "−";
  return `${sign}${fmtCurrency(Math.abs(delta))}`;
}

// ── Visit state helpers (unchanged) ───────────────────────────────────────────

function visitState(lastViewedAt: Date | null, hasData: boolean): VisitState {
  if (!hasData) return "new_user";
  if (!lastViewedAt) return "away";
  const diffMs = Date.now() - lastViewedAt.getTime();
  const diffH  = diffMs / (1000 * 60 * 60);
  if (diffH <  1) return "immediate";
  if (diffH <  6) return "short";
  if (diffH < 24) return "day";
  return "away";
}

function contextLine(state: VisitState, name: string | null): string {
  const displayName = name ? `, ${name.split(" ")[0]}` : "";
  switch (state) {
    case "new_user":   return `Welcome to Fourth Meridian${displayName}. Let's build your financial picture.`;
    case "immediate":  return `You're up to date${displayName}.`;
    case "short":      return `Here's where things stand${displayName}.`;
    case "day":        return `Good to see you${displayName}. Here's your daily check-in.`;
    case "away":       return `Welcome back${displayName}. Here's what changed while you were away.`;
  }
}

function sinceLabel(lastViewedAt: Date | null): string {
  if (!lastViewedAt) return "Your financial snapshot";
  const diffMs = Date.now() - lastViewedAt.getTime();
  const diffH  = diffMs / (1000 * 60 * 60);
  if (diffH < 1)    return "In the last hour";
  if (diffH < 24)   return "Since earlier today";
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1)  return "Since yesterday";
  if (diffD <  7)   return `Since ${diffD} days ago`;
  return "Since your last visit";
}

// ── Context domain extractors ─────────────────────────────────────────────────

function accounts(ctx: SpaceContext_AI): AccountsSectionData | null {
  const s = ctx.domains[FinanceDomains.ACCOUNTS];
  return s ? (s.data as AccountsSectionData) : null;
}

function snapshot(ctx: SpaceContext_AI): SnapshotSectionData | null {
  const s = ctx.domains[FinanceDomains.SNAPSHOT_HISTORY];
  return s ? (s.data as SnapshotSectionData) : null;
}

function transactions(ctx: SpaceContext_AI): TransactionsSummaryData | null {
  const s = ctx.domains[FinanceDomains.TRANSACTIONS_SUMMARY];
  return s ? (s.data as TransactionsSummaryData) : null;
}

// ── Onboarding (unchanged) ────────────────────────────────────────────────────

function buildOnboarding(): BriefSection {
  return {
    id:       "onboarding",
    type:     "onboarding",
    priority: 5,
    title:    "Get started",
    items: [
      { id: "ob_bank",    label: "Connect your first bank account",                            tone: "neutral", href: "/dashboard/accounts" },
      { id: "ob_invest",  label: "Add an investment account",                                  tone: "neutral", href: "/dashboard/accounts" },
      { id: "ob_crypto",  label: "Import a crypto wallet",                                     tone: "neutral", href: "/dashboard/accounts" },
      { id: "ob_manual",  label: "Add manual assets — home, vehicle, equipment, or valuables", tone: "neutral", href: "/dashboard/accounts" },
    ],
  };
}

// ── Since Last Visit — now sourced from Context ───────────────────────────────

/**
 * Net worth and account count come from the primary Space's accounts domain.
 * Trend (delta) comes from the snapshot domain's netWorthTrend, which covers
 * the full snapshot history window rather than exact since-last-visit.
 * When no trend data exists, only the current value is shown.
 */
function buildSinceLastVisit(
  primaryCtx:      SpaceContext_AI,
  totalAccounts:   number,
  lastViewedAt:    Date | null,
  pendingInvites:  number,
  trackedAccounts: TrackedAccount[],
): BriefSection | null {
  const acct = accounts(primaryCtx);
  const snap  = snapshot(primaryCtx);

  if (!acct) return null;

  const items: BriefItem[] = [];
  const netWorth = acct.netWorth;

  // Net worth — with trend from snapshot domain if available
  if (snap?.netWorthTrend != null && snap.netWorthTrend !== 0) {
    const tone: BriefTone = snap.netWorthTrend > 0 ? "positive" : "warning";
    items.push({
      id:     "nw_delta",
      label:  "Net worth",
      value:  fmtDelta(snap.netWorthTrend),
      detail: `now ${fmtCurrency(netWorth)}`,
      tone,
    });
  } else {
    items.push({
      id:    "nw_current",
      label: "Net worth",
      value: fmtCurrency(netWorth),
      tone:  "neutral",
    });
  }

  if (totalAccounts > 0) {
    items.push({
      id:    "account_count",
      label: "Accounts tracked",
      value: String(totalAccounts),
      tone:  "neutral",
    });
  }

  if (pendingInvites > 0) {
    items.push({
      id:    "pending_invites",
      label: pendingInvites === 1 ? "Space invite" : "Space invites",
      value: String(pendingInvites),
      tone:  "info",
      href:  "/dashboard/spaces",
    });
  }

  if (items.length === 0) return null;

  return {
    id:       "since_last_visit",
    type:     "since_last_visit",
    priority: 10,
    title:    sinceLabel(lastViewedAt),
    items,
    trackedAccounts,
  };
}

// ── Needs Attention — driven by signals and account health ────────────────────

/**
 * Priority order within the section:
 *   1. NEEDS_REAUTH signals (danger — account syncing is blocked)
 *   2. Sync error accounts (danger — from accounts health summary)
 *   3. STALE_CONNECTION signals (warning)
 *   4. NET_WORTH_DECLINED signal (warning)
 *   5. Low liquidity from accounts domain (warning)
 *
 * Capped at 5 items to match the previous implementation.
 */
function buildAttention(
  allSignals:  ContextSignal[],
  primaryCtx:  SpaceContext_AI,
): BriefSection | null {
  const items: BriefItem[] = [];
  const acct  = accounts(primaryCtx);

  // ── Signals → items ───────────────────────────────────────────────────────
  // Only warning/critical signals belong in the Attention section.

  for (const sig of allSignals) {
    if (sig.severity === 'info') continue;

    switch (sig.type) {
      case SignalType.NEEDS_REAUTH:
        items.push({
          id:    sig.id,
          label: sig.title,
          tone:  "danger",
          href:  "/dashboard/accounts",
        });
        break;

      case SignalType.STALE_CONNECTION:
        items.push({
          id:    sig.id,
          label: sig.title,
          detail: "Manual assets may be out of date",
          tone:  "warning",
          href:  "/dashboard/accounts",
        });
        break;

      case SignalType.NET_WORTH_DECLINED:
        items.push({
          id:    sig.id,
          label: sig.title,
          tone:  "warning",
        });
        break;
    }
  }

  // ── Account sync errors (from health summary, primary Space only) ─────────
  // Not a Slice 5 signal yet, but available in the accounts domain health.

  if (acct && acct.health.errorCount > 0) {
    const names = acct.health.errorAccountNames;
    if (names.length > 0) {
      for (const name of names) {
        items.push({
          id:   `sync_error_${name}`,
          label: `Sync issue — ${name}`,
          tone:  "danger",
          href:  "/dashboard/accounts",
        });
      }
    } else {
      items.push({
        id:    "sync_error_accounts",
        label: `${acct.health.errorCount} account${acct.health.errorCount > 1 ? "s" : ""} have sync errors`,
        tone:  "danger",
        href:  "/dashboard/accounts",
      });
    }
  }

  // ── Low liquidity (primary Space accounts domain) ─────────────────────────
  if (acct && acct.netWorth > 5000 && acct.totalLiquid >= 0 && acct.totalLiquid / acct.netWorth < 0.05) {
    items.push({
      id:     "low_liquidity",
      label:  "Low cash position",
      value:  fmtCurrency(acct.totalLiquid),
      detail: "Less than 5% of net worth is liquid",
      tone:   "warning",
    });
  }

  if (items.length === 0) return null;

  return {
    id:       "attention",
    type:     "attention",
    priority: 15,
    title:    "Needs Attention",
    items:    items.slice(0, 5),
    tone:     "warning",
  };
}

// ── Insight — driven by signals, context data, and cached AI advice ───────────

/**
 * Prefers cached AI advice when present.
 * Otherwise synthesizes a rule-based insight using:
 *   - NET_WORTH_INCREASED signal (positive trend)
 *   - GOAL_COMPLETED signal (achievement)
 *   - Transaction summary (income vs expense picture)
 *   - Accounts domain (debt ratio, cash ratio)
 */
function buildInsight(
  allSignals:   ContextSignal[],
  primaryCtx:   SpaceContext_AI,
  advice:       { summary: string; adviceText: string } | null,
): BriefSection | null {
  // Prefer cached AI advice
  if (advice?.summary) {
    return {
      id:          "insight",
      type:        "insight",
      priority:    20,
      title:       "Today's Insight",
      body:        advice.summary,
      actionLabel: "View full analysis",
      actionHref:  "/dashboard/analyze",
      tone:        "info",
    };
  }

  const acct  = accounts(primaryCtx);
  const txn   = transactions(primaryCtx);
  const snap  = snapshot(primaryCtx);

  const netWorth    = acct?.netWorth    ?? 0;
  const totalAssets = acct?.totalAssets ?? 0;
  const totalDebt   = acct?.totalLiabilities ?? 0;
  const cash        = acct?.totalLiquid ?? 0;

  // ── Signal-driven insights (highest priority) ─────────────────────────────

  // Recently completed goal
  const completedGoalSig = allSignals.find(s => s.type === SignalType.GOAL_COMPLETED);
  if (completedGoalSig) {
    const name = (completedGoalSig.metadata?.goalName as string | undefined) ?? "a goal";
    return {
      id:       "insight",
      type:     "insight",
      priority: 20,
      title:    "Today's Insight",
      body:     `You completed "${name}" — great work. Review your remaining goals and consider setting a new target.`,
      tone:     "positive",
    };
  }

  // Positive net worth trend
  const trendUpSig = allSignals.find(s => s.type === SignalType.NET_WORTH_INCREASED);
  if (trendUpSig && snap?.netWorthTrendPct != null) {
    return {
      id:       "insight",
      type:     "insight",
      priority: 20,
      title:    "Today's Insight",
      body:     `Net worth is up ${snap.netWorthTrendPct.toFixed(1)}% over the last ${snap.snapshotCount} days — ${fmtCurrency(netWorth)} total. Stay consistent.`,
      tone:     "positive",
    };
  }

  // Transaction picture: spending vs income
  if (txn && txn.incomeTotal > 0) {
    const savingsRate = txn.incomeTotal > 0
      ? Math.round(((txn.incomeTotal - txn.expenseTotal) / txn.incomeTotal) * 100)
      : null;
    if (savingsRate !== null && savingsRate > 0) {
      return {
        id:       "insight",
        type:     "insight",
        priority: 20,
        title:    "Today's Insight",
        body:     `You kept ${savingsRate}% of income over the last ${txn.windowDays} days. Expenses were ${fmtCurrency(txn.expenseTotal)} against ${fmtCurrency(txn.incomeTotal)} in income.`,
        tone:     "info",
      };
    }
  }

  // ── Rule-based fallback (mirrors previous logic) ──────────────────────────

  if (totalAssets === 0 && totalDebt === 0) return null;

  let body: string;
  const debtRatio = totalAssets > 0 ? totalDebt / totalAssets : 0;
  const cashRatio = netWorth    > 0 ? cash      / netWorth    : 0;

  if (debtRatio > 0.5) {
    body = "Debt makes up more than half your total assets. Reducing high-interest balances can significantly improve your net position.";
  } else if (cashRatio > 0.4) {
    body = "A large share of your net worth is sitting in cash. Consider whether any of it could be working harder in investments or savings.";
  } else if (netWorth > 0 && totalDebt === 0) {
    body = "You're carrying no debt — a strong position. Make sure your cash and investment allocations are aligned with your goals.";
  } else if (netWorth > 0) {
    body = `Your net worth stands at ${fmtCurrency(netWorth)}. Stay consistent and check in regularly to spot trends early.`;
  } else {
    return null;
  }

  return {
    id:       "insight",
    type:     "insight",
    priority: 20,
    title:    "Today's Insight",
    body,
    tone:     "info",
  };
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;

  // ── User metadata (non-financial) ──────────────────────────────────────────
  const dbUser = await db.user.findUnique({
    where:  { id: user.id },
    select: { lastBriefViewedAt: true, firstName: true, name: true },
  });
  if (!dbUser) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const lastViewedAt = dbUser.lastBriefViewedAt;
  const displayName  = dbUser.firstName ?? dbUser.name ?? null;

  // ── Eligible Space memberships ─────────────────────────────────────────────
  // OWNER, ADMIN, MEMBER roles only — VIEWER Spaces are excluded from the brief.

  const memberships = await db.spaceMember.findMany({
    where: {
      userId: user.id,
      status: "ACTIVE",
      role:   { in: [SpaceMemberRole.OWNER, SpaceMemberRole.ADMIN, SpaceMemberRole.MEMBER] },
      space:  { archivedAt: null, deletedAt: null },
    },
    select: {
      spaceId: true,
      space:   { select: { type: true } },
    },
  });

  if (memberships.length === 0) {
    return NextResponse.json({ error: "No space" }, { status: 404 });
  }

  // Primary Space: personal Space preferred; first eligible as fallback.
  const primaryMembership =
    memberships.find((m) => m.space.type === "PERSONAL") ?? memberships[0];

  // ── Build context for every eligible Space in parallel ─────────────────────
  // scopeHint='brief' keeps each context lean (no per-account list, no raw
  // transaction history, no full snapshot series).

  const contextResults = await Promise.allSettled(
    memberships.map((m) =>
      buildContext(m.spaceId, user.id, { scopeHint: "brief" }),
    ),
  );

  const successfulContexts: SpaceContext_AI[] = contextResults
    .filter((r): r is PromiseFulfilledResult<SpaceContext_AI> => r.status === "fulfilled")
    .map((r) => r.value);

  // Log failures so they are visible without crashing the brief.
  // A missing AiAgent is an expected, self-correcting data-integrity gap
  // (auto-created on Space creation; backfilled by scripts/backfill-ai-agents.ts).
  // It degrades gracefully here, so aggregate it into a single warn rather than
  // one error per Space per load. Any other rejection is unexpected — surface it.
  const missingAgentSpaceIds: string[] = [];
  contextResults.forEach((r, i) => {
    if (r.status !== "rejected") return;
    const spaceId = memberships[i]?.spaceId;
    const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
    if (message.includes("No AiAgent found")) {
      if (spaceId) missingAgentSpaceIds.push(spaceId);
    } else {
      console.error(`[brief] buildContext failed for Space ${spaceId}:`, r.reason);
    }
  });
  if (missingAgentSpaceIds.length > 0) {
    console.warn(
      `[brief] Skipped ${missingAgentSpaceIds.length} Space(s) with no AiAgent ` +
      `(run scripts/backfill-ai-agents.ts to backfill): ${missingAgentSpaceIds.join(", ")}`,
    );
  }

  // ── Primary context ────────────────────────────────────────────────────────
  const primaryCtx =
    successfulContexts.find((c) => c.spaceId === primaryMembership.spaceId) ??
    successfulContexts[0] ??
    null;

  const hasData = primaryCtx !== null && accounts(primaryCtx) !== null;

  // ── Aggregated signals (all eligible Spaces, sorted by severity) ───────────
  // Signals from each context are already sorted by the registry.
  // Merge and re-sort across all Spaces.
  const SEVERITY_ORDER: Record<ContextSignal["severity"], number> = {
    critical: 0, warning: 1, info: 2,
  };
  const allSignals: ContextSignal[] = successfulContexts
    .flatMap((c) => c.signals)
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.detectedAt.localeCompare(b.detectedAt),
    );

  // ── Cross-Space distinct account count ─────────────────────────────────────
  // "Accounts tracked" counts distinct real FinancialAccounts visible to the
  // user, not SpaceAccountLink placements. Each Space's accounts domain reports
  // the FinancialAccount ids it can see (accountIds); deduplicating across
  // Spaces via a Set means an account shared into multiple Spaces counts once.
  const totalAccountCount = new Set(
    successfulContexts.flatMap((c) => accounts(c)?.accountIds ?? []),
  ).size;

  // ── Cross-Space distinct account roster ("Accounts Tracked" tab) ───────────
  // Flatten each Space's privacy-safe roster and deduplicate by
  // FinancialAccount.id so an account shared into multiple Spaces appears once.
  // When the same account is visible at different levels across Spaces, keep the
  // highest-visibility copy (FULL > BALANCE_ONLY > SUMMARY_ONLY). The resulting
  // length equals totalAccountCount by construction (same ids, deduped).
  const VISIBILITY_RANK: Record<TrackedAccount["visibility"], number> = {
    FULL: 3, BALANCE_ONLY: 2, SUMMARY_ONLY: 1,
  };
  const trackedById = new Map<string, TrackedAccount>();
  for (const c of successfulContexts) {
    for (const a of accounts(c)?.trackedAccounts ?? []) {
      const existing = trackedById.get(a.id);
      if (!existing || VISIBILITY_RANK[a.visibility] > VISIBILITY_RANK[existing.visibility]) {
        trackedById.set(a.id, a);
      }
    }
  }
  const trackedAccounts: TrackedAccount[] = [...trackedById.values()];

  // ── Pending Space invites (non-financial query) ────────────────────────────
  const pendingInviteCount = await db.spaceInvite.count({
    where: { invitedUserId: user.id, status: "PENDING" },
  });

  // ── Cached AI advice (primary Space) ──────────────────────────────────────
  const advice = hasData && primaryCtx
    ? await db.aiAdvice.findFirst({
        where:   { spaceId: primaryCtx.spaceId },
        orderBy: { generatedAt: "desc" },
        select:  { summary: true, adviceText: true },
      })
    : null;

  // ── Visit state ───────────────────────────────────────────────────────────
  const state   = visitState(lastViewedAt, hasData);
  const context = contextLine(state, displayName);

  // ── Build sections ─────────────────────────────────────────────────────────
  const sections: BriefSection[] = [];

  if (!hasData || !primaryCtx) {
    sections.push(buildOnboarding());
  } else {
    const sinceSection = buildSinceLastVisit(
      primaryCtx,
      totalAccountCount,
      lastViewedAt,
      pendingInviteCount,
      trackedAccounts,
    );
    if (sinceSection) sections.push(sinceSection);

    const attentionSection = buildAttention(allSignals, primaryCtx);
    if (attentionSection) sections.push(attentionSection);

    const insightSection = buildInsight(allSignals, primaryCtx, advice);
    if (insightSection) sections.push(insightSection);
  }

  sections.sort((a, b) => a.priority - b.priority);

  // ── Map data (empty markers in brief mode — no per-account detail available)
  // Map hero rendering does not require markers in the current UI.
  const map: FinancialMapData = { markers: [], hasLocations: false };

  const payload: BriefPayload = {
    visitState:  state,
    contextLine: context,
    hasData,
    sections,
    map,
    generatedAt: new Date().toISOString(),
  };

  return NextResponse.json(payload);
}
