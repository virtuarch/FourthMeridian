/**
 * GET /api/brief
 *
 * Returns a BriefPayload for the Daily Brief page.
 * Uses real data only — no fabrication.
 * Sections are rule-based; AI generation is deferred.
 */

import { NextResponse }          from "next/server";
import { db }                    from "@/lib/db";
import { requireUser }           from "@/lib/session";
import { getSpaceContext }   from "@/lib/space";
import { ShareStatus }           from "@prisma/client";
import type {
  BriefPayload,
  BriefSection,
  BriefItem,
  BriefTone,
  VisitState,
  FinancialMapData,
  FinancialMapMarker,
} from "@/lib/brief-types";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Section builders ──────────────────────────────────────────────────────────

/** Since Last Visit section — net worth delta, account count, event count. */
function buildSinceLastVisit(
  netWorth:         number,
  prevNetWorth:     number | null,
  accountCount:     number,
  sinceLabel:       string,
  pendingInvites:   number,
): BriefSection | null {
  const items: BriefItem[] = [];

  if (prevNetWorth !== null) {
    const delta = netWorth - prevNetWorth;
    const tone: BriefTone = delta > 0 ? "positive" : delta < 0 ? "warning" : "neutral";
    items.push({
      id:     "nw_delta",
      label:  "Net worth",
      value:  fmtDelta(delta),
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

  if (accountCount > 0) {
    items.push({
      id:    "account_count",
      label: "Accounts tracked",
      value: String(accountCount),
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
    title:    sinceLabel,
    items,
  };
}

/** Rule-based insight from snapshot data. */
function buildInsight(
  netWorth:    number,
  totalAssets: number,
  totalDebt:   number,
  cash:        number,
  advice:      { summary: string; adviceText: string } | null,
): BriefSection | null {
  // Prefer cached AI advice summary
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

  // Rule-based fallback
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

/** Needs Attention — rule-based flags. */
function buildAttention(
  accounts: {
    type:            string;
    balance:         number;
    creditLimit?:    number | null;
    syncStatus?:     string | null;
    lastUpdated:     Date;
    name:            string;
    interestRate?:   number | null;
    minimumPayment?: number | null;
  }[],
  netWorth: number,
  cash:     number,
): BriefSection | null {
  const items: BriefItem[] = [];
  const now = new Date();

  for (const acct of accounts) {
    // High credit utilization (> 70%)
    if (
      acct.type === "debt" &&
      acct.creditLimit &&
      acct.creditLimit > 0 &&
      Math.abs(acct.balance) / acct.creditLimit > 0.7
    ) {
      const utilPct = Math.round((Math.abs(acct.balance) / acct.creditLimit) * 100);
      items.push({
        id:     `high_util_${acct.name}`,
        label:  `High utilization — ${acct.name}`,
        value:  `${utilPct}%`,
        detail: "Consider paying down this balance",
        tone:   "warning",
        href:   "/dashboard/credit",
      });
    }

    // Sync error
    if (acct.syncStatus === "error") {
      items.push({
        id:    `sync_error_${acct.name}`,
        label: `Sync issue — ${acct.name}`,
        tone:  "danger",
        href:  "/dashboard/accounts",
      });
    }

    // Manual asset not updated in 30+ days
    if (acct.syncStatus === "manual") {
      const daysSince = (now.getTime() - acct.lastUpdated.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > 30) {
        items.push({
          id:     `stale_manual_${acct.name}`,
          label:  `${acct.name} not updated in ${Math.floor(daysSince)} days`,
          detail: "Manual assets may be out of date",
          tone:   "warning",
          href:   "/dashboard/accounts",
        });
      }
    }
  }

  // Low liquidity: cash < 5% of net worth (and net worth > 0)
  if (netWorth > 5000 && cash >= 0 && cash / netWorth < 0.05) {
    items.push({
      id:     "low_liquidity",
      label:  "Low cash position",
      value:  fmtCurrency(cash),
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
    items:    items.slice(0, 5), // cap at 5
    tone:     "warning",
  };
}

/** Onboarding section for new users. */
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

// ── Map marker derivation ─────────────────────────────────────────────────────
// Note: map data is kept in the BriefPayload for future hero pin rendering.
// buildMapSection is intentionally removed — the earth hero IS the footprint.

function deriveMapMarkers(
  accounts: { id: string; name: string; type: string; institution: string; balance: number; }[],
): FinancialMapData {
  const markers: FinancialMapMarker[] = [];

  // Group by institution to avoid duplicate pins
  const seen = new Set<string>();

  for (const acct of accounts) {
    const key = acct.institution.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const markerType: FinancialMapMarker["type"] =
      acct.type === "investment"  ? "investment"  :
      acct.type === "crypto"      ? "crypto"      :
      acct.type === "debt"        ? "bank"        :
      acct.type === "checking" || acct.type === "savings" ? "bank" :
      acct.type === "other"       ? "asset"       :
      "other";

    markers.push({
      id:           acct.id,
      label:        acct.institution,
      type:         markerType,
      privacyLevel: "summary",
      value:        Math.abs(acct.balance),
    });
  }

  return { markers, hasLocations: false };
}

// ── Since-label helper ────────────────────────────────────────────────────────

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

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;

  // Fetch user's lastBriefViewedAt and name
  const dbUser = await db.user.findUnique({
    where:  { id: user.id },
    select: { lastBriefViewedAt: true, firstName: true, name: true },
  });
  if (!dbUser) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const lastViewedAt = dbUser.lastBriefViewedAt;
  const displayName  = dbUser.firstName ?? dbUser.name ?? null;

  // Get the user's personal space context
  let spaceId: string;
  try {
    const ctx = await getSpaceContext();
    spaceId = ctx.spaceId;
  } catch {
    return NextResponse.json({ error: "No space" }, { status: 404 });
  }

  // ── Accounts ──────────────────────────────────────────────────────────────
  // D3 Step 4D read cutover — replaces the prior db.workspaceAccountShare
  // query. Same status: ACTIVE visibility gate and financialAccount.deletedAt
  // guard; no filter on `kind` (HOME vs SHARED both confer visibility), same
  // as every other D3 Step 4 cutover. See docs/D3_STEP4_READ_CUTOVER_REVIEW.md.
  const links = await db.spaceAccountLink.findMany({
    where: {
      spaceId,
      status:           ShareStatus.ACTIVE,
      financialAccount: { deletedAt: null },
    },
    include: { financialAccount: true },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accounts = links.map(({ financialAccount: r }: any) => ({
    id:            r.id as string,
    name:          r.name as string,
    type:          r.type as string,
    institution:   r.institution as string,
    balance:       r.balance as number,
    creditLimit:   r.creditLimit  as number | null,
    syncStatus:    r.syncStatus   as string | null,
    lastUpdated:   r.lastUpdated  as Date,
    interestRate:  r.interestRate as number | null,
    minimumPayment:r.minimumPayment as number | null,
  }));

  const hasData = accounts.length > 0;

  // ── Compute net worth ──────────────────────────────────────────────────────
  let netWorth    = 0;
  let totalAssets = 0;
  let totalDebt   = 0;
  let cash        = 0;

  for (const a of accounts) {
    if (a.type === "debt") {
      totalDebt += Math.abs(a.balance);
    } else {
      totalAssets += a.balance;
      if (a.type === "checking" || a.type === "savings") {
        cash += a.balance;
      }
    }
  }
  netWorth = totalAssets - totalDebt;

  // ── Prior net worth from most recent snapshot ──────────────────────────────
  let prevNetWorth: number | null = null;
  if (hasData && lastViewedAt) {
    const snap = await db.spaceSnapshot.findFirst({
      where:   { spaceId, date: { lte: lastViewedAt } },
      orderBy: { date: "desc" },
      select:  { netWorth: true },
    });
    if (snap) prevNetWorth = snap.netWorth;
  }

  // ── Cached AI advice ───────────────────────────────────────────────────────
  const advice = hasData
    ? await db.aiAdvice.findFirst({
        where:   { spaceId },
        orderBy: { generatedAt: "desc" },
        select:  { summary: true, adviceText: true },
      })
    : null;

  // ── Pending space invites ──────────────────────────────────────────────
  const pendingInviteCount = await db.spaceInvite.count({
    where: { invitedUserId: user.id, status: "PENDING" },
  });

  // ── Visit state & context ─────────────────────────────────────────────────
  const state   = visitState(lastViewedAt, hasData);
  const context = contextLine(state, displayName);

  // ── Build sections ─────────────────────────────────────────────────────────
  const sections: BriefSection[] = [];

  if (!hasData) {
    sections.push(buildOnboarding());
  } else {
    const sinceSection = buildSinceLastVisit(
      netWorth,
      prevNetWorth,
      accounts.length,
      sinceLabel(lastViewedAt),
      pendingInviteCount,
    );
    if (sinceSection) sections.push(sinceSection);

    const attentionSection = buildAttention(accounts, netWorth, cash);
    if (attentionSection) sections.push(attentionSection);

    const insightSection = buildInsight(netWorth, totalAssets, totalDebt, cash, advice);
    if (insightSection) sections.push(insightSection);
  }

  // Map data is kept in the payload for future hero pin rendering —
  // it no longer renders as a standalone section card.
  const map = deriveMapMarkers(accounts);

  // Sort by priority ascending (lower = higher up the page)
  sections.sort((a, b) => a.priority - b.priority);

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
