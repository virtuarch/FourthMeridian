/**
 * lib/timeline-placeholder.ts
 *
 * Demonstrates the full Timeline event vocabulary from the Spaces redesign
 * spec — transaction, document upload, new member, member removed, account
 * linked/removed, AI recommendation, goal reached, manual asset added,
 * wallet added, recurring payment, investment milestone, note, reminder —
 * for event types that have no real backend aggregation yet (see the
 * ALLOWED_ACTIONS allowlist in app/api/workspaces/[id]/activity/route.ts,
 * which intentionally is NOT touched by this pass).
 *
 * Every event here is `isPreview: true`. SpaceTimelineWidget merges these
 * with real events from the activity route and badges them distinctly —
 * this is architecture + presentation only, not synthetic "fake history."
 *
 * FUTURE ENHANCEMENT: once a given event type has a real producer (e.g.
 * transactions, document uploads), delete its placeholder entry here and
 * have the producer emit a real TimelineEvent with the same `type`/`icon`
 * — SpaceTimelineWidget needs no changes.
 */

import type { TimelineEvent } from "@/lib/timeline-types";

function daysAgoIso(days: number, hour = 9): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

export const FUTURE_TIMELINE_EVENTS: TimelineEvent[] = [
  {
    id: "preview-transaction", type: "transaction", icon: "Receipt", tone: "neutral",
    date: daysAgoIso(1), title: "Transaction synced", isPreview: true,
    subtitle: "Individual transactions will appear here once Transactions is built.",
  },
  {
    id: "preview-document", type: "document_upload", icon: "FileUp", tone: "info",
    date: daysAgoIso(2), title: "Document uploaded", isPreview: true,
    subtitle: "Document uploads will appear here once Documents is built.",
  },
  {
    id: "preview-account-linked", type: "account_linked", icon: "Link2", tone: "positive",
    date: daysAgoIso(4), title: "Account linked", isPreview: true,
    subtitle: "New account connections will show up here automatically.",
  },
  {
    id: "preview-ai-recommendation", type: "ai_recommendation", icon: "Sparkles", tone: "info",
    date: daysAgoIso(5), title: "AI recommendation", isPreview: true,
    subtitle: "Daily Brief insights will be able to drop a note here.",
  },
  {
    id: "preview-wallet-added", type: "wallet_added", icon: "Wallet", tone: "positive",
    date: daysAgoIso(7), title: "Wallet added", isPreview: true,
    subtitle: "Manually tracked wallets will log here when added.",
  },
  {
    id: "preview-recurring-payment", type: "recurring_payment", icon: "Repeat", tone: "neutral",
    date: daysAgoIso(9), title: "Recurring payment", isPreview: true,
    subtitle: "Detected recurring payments will post here on each occurrence.",
  },
  {
    id: "preview-investment-milestone", type: "investment_milestone", icon: "Trophy", tone: "positive",
    date: daysAgoIso(12), title: "Investment milestone", isPreview: true,
    subtitle: "Portfolio milestones (e.g. crossing a value threshold) will land here.",
  },
  {
    id: "preview-reminder", type: "reminder", icon: "BellRing", tone: "warning",
    date: daysAgoIso(14), title: "Reminder", isPreview: true,
    subtitle: "Upcoming bills or renewals will be able to surface as reminders.",
  },
];
