/**
 * lib/platform/customer/onboarding-core.ts  (PB-7 — the customer's Onboarding timeline, pure)
 *
 * Owner (2026-11-01): "is the sign up process going healthy for them? … I
 * really want to know and have visibility as users been to onboard."
 *
 * One customer's onboarding, in order, from facts that already exist:
 *   registered (invited vs uninvited)   User.createdAt · BetaAccessRequest.invitedAt/redeemedAt
 *   email verified                      User.emailVerifiedAt
 *   first session                       min(UserSession.createdAt)
 *   per connection: linked → import → first wealth regen
 *                                       PlaidItem markers + the refresh ledger (import-status-core)
 *   first AI turn                       min(AiInvocation.occurredAt, surface chat)
 *   first Brief                         min(AuditLog BRIEF_VIEWED)
 *
 * Rendered ONLY inside the audited Customer Success profile (the detail route
 * records CUSTOMER_PROFILE_VIEWED before the profile leaves the server). Counts,
 * kinds and timestamps only: no transaction, amount, merchant, token or
 * cursor is ever an input here, so none can be an output.
 *
 * Pure: no I/O, no clock.
 */

import {
  IMPORT_REASON_LABELS, type ImportHealthDot, type ImportReasonCategory, type ImportStatus, type ImportedItem, importHealthDot,
} from "@/lib/platform/onboarding/import-status-core";

export interface OnboardingConnection {
  id: string;
  kind: "BANK" | "WALLET";
  /** The institution (bank) or chain (wallet) — the same label the profile's Connections section shows. */
  label: string;
  linkedAt: string;
  /** Bank imports only; null for a wallet (no first-import ledger exists for wallets). */
  importStatus: ImportStatus | null;
  /** in_progress only — the newest attempt failed and a resume is pending. */
  interrupted: boolean;
  reason: ImportReasonCategory | null;
  reasonLabel: string | null;
  transactions: number | null;
  importCompletedAt: string | null;
  firstWealthRegenAt: string | null;
  /** Import-window executions, and how many ended mid-run (reaped). */
  attempts: number;
  interruptedAttempts: number;
}

export type OnboardingEventKind =
  | "registered" | "email_verified" | "first_session" | "linked" | "import" | "wealth_regen" | "first_ai_turn" | "first_brief";

export interface OnboardingEvent {
  at: string;
  kind: OnboardingEventKind;
  /** Plain words — no customer content. */
  label: string;
  tone: "ok" | "warn" | "bad" | "neutral";
  /** The connection the event belongs to, when it is a per-connection event. */
  connectionId: string | null;
}

export interface OnboardingTimeline {
  registeredAt: string;
  invited: boolean;
  emailVerifiedAt: string | null;
  firstSessionAt: string | null;
  firstAiTurnAt: string | null;
  firstBriefAt: string | null;
  connections: OnboardingConnection[];
  /** The Recently-joined dot for this customer (worst of the bank imports). */
  importHealth: ImportHealthDot;
  /** Facts in time order; steps not reached yet are listed in `pending`. */
  events: OnboardingEvent[];
  pending: string[];
  /** A read hit its row cap — the import verdicts are a floor. */
  floor: boolean;
}

export interface OnboardingFacts {
  user: { createdAt: Date; emailVerifiedAt: Date | null };
  /** The customer's beta request, when one exists (invited = an invitation was issued or redeemed). */
  request: { invitedAt: Date | null; redeemedAt: Date | null } | null;
  firstSessionAt: Date | null;
  firstAiTurnAt: Date | null;
  firstBriefAt: Date | null;
  banks: readonly ImportedItem[];
  wallets: readonly { id: string; provider: string; createdAt: Date }[];
  floor?: boolean;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const n = (v: number) => v.toLocaleString("en-US");

export const IMPORT_STATUS_WORDS: Readonly<Record<ImportStatus, string>> = {
  in_progress: "import in progress",
  complete: "import complete",
  recovered: "import recovered after interruption",
  failed: "import failed",
  removed: "connection removed",
};

function importEvent(c: OnboardingConnection): OnboardingEvent | null {
  if (c.importStatus === null) return null;
  const why = c.reasonLabel ? ` — ${c.reasonLabel}` : "";
  const tx = c.transactions !== null ? ` · ${n(c.transactions)} transaction${c.transactions === 1 ? "" : "s"}` : "";
  switch (c.importStatus) {
    case "complete":
      return c.importCompletedAt ? { at: c.importCompletedAt, kind: "import", label: `${c.label}: import complete${tx}`, tone: "ok", connectionId: c.id } : null;
    case "recovered":
      return c.importCompletedAt
        ? { at: c.importCompletedAt, kind: "import", label: `${c.label}: import recovered after interruption${tx}${why}`, tone: "warn", connectionId: c.id }
        : null;
    default:
      return null; // in progress / failed / removed are states, not timestamped events — shown on the connection row
  }
}

export function buildOnboardingTimeline(f: OnboardingFacts): OnboardingTimeline {
  const banks: OnboardingConnection[] = f.banks.map((b) => ({
    id: b.id, kind: "BANK", label: b.institutionName, linkedAt: b.createdAt.toISOString(),
    importStatus: b.verdict.status, interrupted: b.verdict.interrupted,
    reason: b.verdict.reason, reasonLabel: b.verdict.reason ? IMPORT_REASON_LABELS[b.verdict.reason] : null,
    transactions: b.verdict.transactions, importCompletedAt: iso(b.verdict.completedAt), firstWealthRegenAt: iso(b.verdict.firstWealthRegenAt),
    attempts: b.verdict.executions, interruptedAttempts: b.verdict.reapedExecutions,
  }));
  const wallets: OnboardingConnection[] = f.wallets.map((w) => ({
    id: w.id, kind: "WALLET", label: `${w.provider.charAt(0)}${w.provider.slice(1).toLowerCase()} wallet`, linkedAt: w.createdAt.toISOString(),
    importStatus: null, interrupted: false, reason: null, reasonLabel: null, transactions: null,
    importCompletedAt: null, firstWealthRegenAt: null, attempts: 0, interruptedAttempts: 0,
  }));
  const connections = [...banks, ...wallets].sort((a, b) => a.linkedAt.localeCompare(b.linkedAt) || a.id.localeCompare(b.id));
  const invited = !!(f.request && (f.request.invitedAt || f.request.redeemedAt));

  const events: OnboardingEvent[] = [
    { at: f.user.createdAt.toISOString(), kind: "registered", label: invited ? "Registered (invited)" : "Registered (no invitation on record)", tone: "neutral", connectionId: null },
  ];
  if (f.user.emailVerifiedAt) events.push({ at: f.user.emailVerifiedAt.toISOString(), kind: "email_verified", label: "Email verified", tone: "ok", connectionId: null });
  if (f.firstSessionAt) events.push({ at: f.firstSessionAt.toISOString(), kind: "first_session", label: "First session", tone: "neutral", connectionId: null });
  for (const c of connections) {
    events.push({ at: c.linkedAt, kind: "linked", label: `${c.label} linked`, tone: "neutral", connectionId: c.id });
    const imp = importEvent(c);
    if (imp) events.push(imp);
    if (c.firstWealthRegenAt) events.push({ at: c.firstWealthRegenAt, kind: "wealth_regen", label: `${c.label}: wealth history built`, tone: "ok", connectionId: c.id });
  }
  if (f.firstAiTurnAt) events.push({ at: f.firstAiTurnAt.toISOString(), kind: "first_ai_turn", label: "First AI conversation turn", tone: "neutral", connectionId: null });
  if (f.firstBriefAt) events.push({ at: f.firstBriefAt.toISOString(), kind: "first_brief", label: "First Brief viewed", tone: "neutral", connectionId: null });
  const ORDER: Record<OnboardingEventKind, number> = { registered: 0, email_verified: 1, first_session: 2, linked: 3, import: 4, wealth_regen: 5, first_ai_turn: 6, first_brief: 7 };
  events.sort((a, b) => a.at.localeCompare(b.at) || ORDER[a.kind] - ORDER[b.kind]);

  const pending: string[] = [];
  if (!f.user.emailVerifiedAt) pending.push("Email not verified");
  if (!f.firstSessionAt) pending.push("No session recorded");
  if (connections.length === 0) pending.push("No connection linked");
  for (const c of banks) {
    if (c.importStatus === "in_progress") pending.push(`${c.label}: import in progress${c.interrupted ? " — last attempt was interrupted, a resume is pending" : ""}${c.transactions ? ` (${n(c.transactions)} so far)` : ""}`);
    if (c.importStatus === "failed") pending.push(`${c.label}: import failed — ${c.reasonLabel ?? "reason not recorded"}`);
    if ((c.importStatus === "complete" || c.importStatus === "recovered") && !c.firstWealthRegenAt) pending.push(`${c.label}: no wealth-history build recorded yet`);
  }
  if (!f.firstAiTurnAt) pending.push("No AI conversation yet");
  if (!f.firstBriefAt) pending.push("No Brief viewed yet");

  return {
    registeredAt: f.user.createdAt.toISOString(), invited,
    emailVerifiedAt: iso(f.user.emailVerifiedAt), firstSessionAt: iso(f.firstSessionAt),
    firstAiTurnAt: iso(f.firstAiTurnAt), firstBriefAt: iso(f.firstBriefAt),
    connections, importHealth: importHealthDot(f.banks.map((b) => b.verdict)),
    events, pending, floor: f.floor === true,
  };
}
