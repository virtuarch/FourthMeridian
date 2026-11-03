/**
 * lib/platform/customer/recently-joined-core.ts  (PB-7 — the Recently-joined fold, pure)
 *
 * Folds the facts recently-joined.ts loads into one row per new customer:
 * stage (customer-core projectRollup — the Customers list's own strict fold),
 * invited vs uninvited, and the import-health dot + per-status tally over the
 * customer's bank imports (import-status-core — the Platform Ops tile's rule).
 *
 * Pure: no I/O, no clock.
 */

import { projectRollup } from "./customer-core";
import {
  IMPORT_STATUSES, importHealthDot, tallyImportStatuses,
  type ImportHealthDot, type ImportStatus, type ImportedItem,
} from "@/lib/platform/onboarding/import-status-core";

export interface RecentlyJoinedRow {
  id: string;
  email: string;
  name: string | null;
  username: string | null;
  joinedAt: string;
  invited: boolean;
  /** The furthest onboarding stage reached (FUNNEL_STAGE_LABELS wording). */
  stage: string | null;
  importHealth: ImportHealthDot;
  /** Bank imports by status (every status present). */
  imports: Record<ImportStatus, number>;
  /** Live connections: non-removed bank items + non-revoked wallets. */
  connections: number;
  /** Non-revoked wallets (the dot tracks banks only; a wallet-only customer reads "wallet linked"). */
  wallets: number;
}

export interface RecentlyJoined {
  windowDays: number;
  /** Customers who registered in the window (the rows may be capped — see `floor`). */
  total: number;
  rows: RecentlyJoinedRow[];
  /** Per-status totals over every row's bank imports — the figure the Platform Ops tile shares. */
  importTotals: Record<ImportStatus, number>;
  floor: boolean;
}

export interface RecentlyJoinedFacts {
  firstSession: ReadonlyMap<string, Date>;
  firstConnection: ReadonlyMap<string, Date>;
  firstAiTurn: ReadonlyMap<string, Date>;
  firstBriefView: ReadonlyMap<string, Date>;
  lastEngaged: ReadonlyMap<string, Date>;
  /** Lower-cased emails with an issued or redeemed invitation. */
  invitedEmails: ReadonlySet<string>;
  walletCount: ReadonlyMap<string, number>;
}

export function buildRecentlyJoinedRows(args: {
  windowDays: number;
  total: number;
  users: readonly { id: string; email: string; name: string | null; username: string | null; createdAt: Date; emailVerifiedAt: Date | null }[];
  facts: RecentlyJoinedFacts;
  imports: readonly ImportedItem[];
  floor: boolean;
}): RecentlyJoined {
  const byOwner = new Map<string, ImportedItem[]>();
  for (const i of args.imports) if (i.userId) byOwner.set(i.userId, [...(byOwner.get(i.userId) ?? []), i]);

  const rows: RecentlyJoinedRow[] = args.users.map((u) => {
    const items = byOwner.get(u.id) ?? [];
    const verdicts = items.map((i) => i.verdict);
    const { funnelStage } = projectRollup({
      invocations30d: [], plaidItemCount: items.length, lastEngagedAt: args.facts.lastEngaged.get(u.id) ?? null,
      stage: {
        createdAt: u.createdAt, emailVerifiedAt: u.emailVerifiedAt,
        firstSession: args.facts.firstSession.get(u.id) ?? null, firstConnection: args.facts.firstConnection.get(u.id) ?? null,
        firstAiTurn: args.facts.firstAiTurn.get(u.id) ?? null, firstBriefView: args.facts.firstBriefView.get(u.id) ?? null,
      },
    });
    return {
      id: u.id, email: u.email, name: u.name, username: u.username, joinedAt: u.createdAt.toISOString(),
      invited: args.facts.invitedEmails.has(u.email.toLowerCase()),
      stage: funnelStage,
      importHealth: importHealthDot(verdicts),
      imports: tallyImportStatuses(verdicts),
      connections: verdicts.filter((v) => v.status !== "removed").length + (args.facts.walletCount.get(u.id) ?? 0),
      wallets: args.facts.walletCount.get(u.id) ?? 0,
    };
  });

  const importTotals = Object.fromEntries(IMPORT_STATUSES.map((s) => [s, rows.reduce((a, r) => a + r.imports[s], 0)])) as Record<ImportStatus, number>;
  return { windowDays: args.windowDays, total: args.total, rows, importTotals, floor: args.floor };
}
