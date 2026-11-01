/**
 * lib/connections/connection-summary.ts  (Connections redesign — PR 1)
 *
 * PURE. The one-line summary a Connections ROW shows: a health word, a tone, the
 * provider, the account count and the last successful update. The row is a
 * pointer into the drawer, so it carries no reason codes, no provider errors and
 * no internal identifiers. Every word here is derived from the SAME authorities
 * the drawer reads:
 *
 *   - SyncConnection.state           (lib/sync/status.ts — the lifecycle state)
 *   - ConnectionIntelligenceStatus   (lib/connections/intelligence.ts — phase)
 *   - sourceHealth                   (space-data-health.core deriveSourceHealth —
 *                                     the rule the Daily Brief uses too)
 *
 * so a row can never say "Up to date" beside a drawer that says "Hasn't updated
 * since …". Never a percentage: nothing here measures progress.
 */

import { providerName, type SyncConnection } from "@/lib/sync/status";
import type { ConnectionIntelligenceStatus } from "@/lib/connections/intelligence";
import type { DataSourceState } from "@/lib/connections/space-data-health.core";

/** ok = nothing to do · progress = work genuinely running · attention = the user can act · neutral = waiting on us. */
export type ConnectionTone = "ok" | "progress" | "attention" | "neutral";

export interface ConnectionSummary {
  tone:          ConnectionTone;
  /** Short health word for the row ("Up to date", "Importing", "Reconnect needed"). */
  status:        string;
  /** "Plaid" / "Self-custody" — the provider, never a credential. */
  provider:      string;
  /** "3 accounts" / "1 wallet" — names live in the drawer. */
  accountsLabel: string;
  /** The last SUCCESSFUL update for the source, or null when there has never been one. */
  updatedAt:     string | null;
}

/** sourceHealth words for a READY connection whose source still needs attention. */
const HEALTH_WORD: Partial<Record<DataSourceState, { status: string; tone: ConnectionTone }>> = {
  OUT_OF_DATE:      { status: "Out of date",       tone: "attention" },
  SYNC_INCOMPLETE:  { status: "Update incomplete", tone: "attention" },
  NEEDS_RECONNECT:  { status: "Reconnect needed",  tone: "attention" },
  CONNECTION_ERROR: { status: "Connection issue",  tone: "attention" },
  DISCONNECTED:     { status: "Disconnected",      tone: "neutral" },
  NEVER_UPDATED:    { status: "Not updated yet",   tone: "neutral" },
};

export function summarizeConnection(
  connection: SyncConnection,
  intelligence: ConnectionIntelligenceStatus | undefined,
  accountCount: number,
): ConnectionSummary {
  const noun = connection.provider === "WALLET" ? "wallet" : "account";
  const base = {
    provider:      providerName(connection.provider),
    accountsLabel: `${accountCount} ${noun}${accountCount === 1 ? "" : "s"}`,
    updatedAt:     intelligence?.sourceHealth?.lastUpdatedAt ?? connection.lastSyncedAt,
  };
  const word = (status: string, tone: ConnectionTone): ConnectionSummary => ({ ...base, status, tone });

  switch (connection.state) {
    case "importing":     return word("Importing", "progress");
    case "import_paused": return word("Import paused", "neutral");
    case "sync_deferred": return word("Sync pending", "neutral");
    case "needs_reauth":  return word("Reconnect needed", "attention");
    case "error":         return word("Sync issue", "attention");
    case "ready": {
      if (intelligence?.phase === "BUILDING_INTELLIGENCE") return word("Building history", "progress");
      if (intelligence?.phase === "INTELLIGENCE_NOT_BUILT") return word("History not built", "attention");
      const h = intelligence?.sourceHealth;
      const mapped = h?.needsAttention ? HEALTH_WORD[h.state] : undefined;
      if (mapped) return word(mapped.status, mapped.tone);
      // A wallet whose current holdings are fresh but whose history is not
      // proven is NOT simply "up to date" (Connections detail refinement).
      const wh = intelligence?.walletHistory;
      if (connection.provider === "WALLET") {
        // The badge speaks for CURRENT holdings and says what history is doing —
        // never an unqualified "Up to date" that reads as "everything is done".
        const imp = wh?.historyImport?.state;
        if (imp === "FAILED" || imp === "RECOVERY_REQUIRED") return word("History needs attention", "attention");
        if (imp === "IMPORTING") return word("Importing history", "progress");
        if (imp === "QUEUED") return word("History queued", "neutral");
        if (wh?.supported && !wh.licensed) return word("History incomplete", "neutral");
        return word("Holdings current", "ok");
      }
      return word("Up to date", "ok");
    }
  }
}

/** "today" / "yesterday" / "3 days ago" / "on Oct 2" — calendar days, the card's own style. */
export function relativeUpdated(iso: string, now: Date = new Date()): string {
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = Math.floor((day(now) - day(new Date(iso))) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return `on ${new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
