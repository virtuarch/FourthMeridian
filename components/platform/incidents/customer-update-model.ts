/**
 * components/platform/incidents/customer-update-model.ts  (Incident customer update, PR-C2 — PURE view-model)
 *
 * Owner yes; S2 rulings 09gg (c) / 09gm. The words and the rules behind the
 * Customer Success drawer's "Customer update" section
 * (CustomerUpdateSection.tsx). The server (PR-C1, #556) decides every refusal;
 * this module only presents what the read model, the preview and the send
 * routes return:
 *
 *   lint codes            → plain-language problems (never the text echoed);
 *   the 600-char counter  → "N of 600" with an over-limit flag;
 *   the dedupe facts      → "Reconnect request already sent <relative> (<outcome>)"
 *                           with the 24 h quiet window, and "An update was
 *                           already sent for this incident";
 *   sendEnabled           → whether a Send control EXISTS at all (S2: strict;
 *                           false ⇒ hidden, never merely disabled);
 *   the send outcome      → words, including "not delivered (customer
 *                           preference)" for not_delivered_preference (09gm 7);
 *   delivery rows         → codes mapped to plain words.
 *
 * PURE and client-safe: no I/O, no recipient identity anywhere in its types
 * (the read model carries `recipient.attributed`, a boolean, and nothing else).
 */

import { lintIncidentCustomerUpdate, type LintCode, type LintResult } from "@/lib/platform/incidents/customer-update/core";
import { INCIDENT_UPDATE_PARAGRAPH_MAX } from "@/lib/notifications/incident-customer-update";

export { INCIDENT_UPDATE_PARAGRAPH_MAX };

// ── Route shapes (what the server returns; codes and booleans only) ─────────

export interface CustomerUpdateReadModel {
  incidentId: string;
  sendEnabled: boolean;
  eligible: boolean;
  recipient: { attributed: boolean };
  template: { title: string; opening: string; closing: string; href: string; paragraphMax: number };
  draft: { paragraph: string; draftClass: string; verifiedRecovery: boolean; draftHash: string };
  lint: LintResult;
  dedupe: {
    episode: { sent: boolean; sentAt: string | null };
    reauthNotice: { outcome: string; at: string; blocksSend: boolean; quietUntil: string | null } | null;
  };
  blockedBy: string[];
  canSend: boolean;
  checkedAt: string;
}

export interface CustomerUpdatePreview {
  message: { title: string; body: string; href: string };
  lint: LintResult;
  paragraphHash: string;
  edited: boolean;
  sendEnabled: boolean;
}

export interface DeliveryRow {
  channel: string;
  status: string;
  reason: string | null;
  errorCode: string | null;
  attempt: number;
  mode: string;
  createdAt: string;
  acceptedAt: string | null;
}

export interface DeliveriesModel {
  incidentId: string;
  items: DeliveryRow[];
  episode: { sent: boolean; sentAt: string | null };
}

// ── API paths (CS tier only) ─────────────────────────────────────────────────

const base = (id: string) => `/api/platform/customer-success/incidents/${encodeURIComponent(id)}`;
export const customerUpdatePath = (id: string) => `${base(id)}/customer-update`;
export const customerUpdatePreviewPath = (id: string) => `${base(id)}/customer-update/preview`;
export const customerUpdateSendPath = (id: string) => `${base(id)}/customer-update/send`;
export const incidentDeliveriesPath = (id: string) => `${base(id)}/deliveries`;

// ── Lint → plain language ───────────────────────────────────────────────────

export const LINT_MESSAGE: Readonly<Record<LintCode, string>> = {
  EMPTY: "Write a short paragraph for the customer.",
  TOO_LONG: `Keep it to ${INCIDENT_UPDATE_PARAGRAPH_MAX} characters or fewer.`,
  LINE_BREAK: "Use one paragraph, with no line breaks.",
  MARKUP: "Remove angle brackets and braces. The paragraph is plain text.",
  LINK: "Remove links, web addresses, email addresses and phone numbers.",
  FIGURE: "Remove numbers and amounts.",
  IDENTIFIER: "Remove account details, institution names and codes.",
  ADVICE: "Remove financial advice or claims.",
  PROMISE: "Don't say the problem is fixed or resolved until recovery is verified.",
};

export function lintMessages(codes: readonly LintCode[]): string[] {
  return codes.map((c) => LINT_MESSAGE[c]).filter((m): m is string => typeof m === "string");
}

/** The live lint the textarea shows (the same pure function the server runs). */
export function lintParagraph(paragraph: string, opts: { verifiedRecovery: boolean; institution?: string | null }): LintResult {
  return lintIncidentCustomerUpdate(paragraph, opts);
}

// ── Counter ─────────────────────────────────────────────────────────────────

export function counterView(paragraph: string, max = INCIDENT_UPDATE_PARAGRAPH_MAX): { text: string; over: boolean; length: number } {
  const length = paragraph.trim().length;
  return { text: `${length} of ${max}`, over: length > max, length };
}

// ── Time ────────────────────────────────────────────────────────────────────

/** "just now", "5 min ago", "3 h ago", "2 days ago"; unparseable ⇒ "earlier". */
export function relativeAgo(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "earlier";
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

/** "in 5 min", "in 3 h"; past or unparseable ⇒ "soon". */
export function relativeUntil(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= now.getTime()) return "soon";
  const m = Math.ceil((t - now.getTime()) / 60_000);
  if (m < 60) return `in ${m} min`;
  return `in ${Math.ceil(m / 60)} h`;
}

// ── Dedupe ──────────────────────────────────────────────────────────────────

export const REAUTH_OUTCOME_WORD: Readonly<Record<string, string>> = {
  created: "notice sent",
  suppressed_duplicate: "an open notice was already showing",
  marked_not_notified: "marked, no notice sent",
  no_change: "no change",
};

export interface DedupeView {
  /** A reconnect-request notice inside the last 24 h, with its outcome; null when none. */
  reauthLine: string | null;
  /** Set when that notice blocks a send: the 24 h quiet window explained. */
  reauthBlockLine: string | null;
  /** Set when the episode already carries a sent update. */
  alreadySentLine: string | null;
}

export function dedupeView(m: Pick<CustomerUpdateReadModel, "dedupe">, now: Date): DedupeView {
  const n = m.dedupe.reauthNotice;
  const reauthLine = n ? `Reconnect request already sent ${relativeAgo(n.at, now)} (${REAUTH_OUTCOME_WORD[n.outcome] ?? "outcome not recorded"}).` : null;
  const reauthBlockLine = n?.blocksSend
    ? `No update can be sent until 24 h after it${n.quietUntil ? ` (${relativeUntil(n.quietUntil, now)})` : ""}, so the customer doesn't get two messages about the same problem.`
    : null;
  const alreadySentLine = m.dedupe.episode.sent ? "An update was already sent for this incident." : null;
  return { reauthLine, reauthBlockLine, alreadySentLine };
}

// ── Send availability ───────────────────────────────────────────────────────

export const BLOCK_WORD: Readonly<Record<string, string>> = {
  NOT_ELIGIBLE: "Only a live incident can carry a customer update.",
  NO_RECIPIENT: "This incident isn't attributed to a customer.",
  ALREADY_SENT: "An update was already sent for this incident.",
  REAUTH_NOTICE_RECENT: "A reconnect request went out in the last 24 h.",
};

export interface SendView {
  /** False ⇒ the Send control is NOT RENDERED (S2: strict; hidden, never merely disabled). */
  showSend: boolean;
  /** When shown but blocked: why, in words (the control is then disabled). Empty ⇒ may send. */
  blockedWords: string[];
}

export function sendView(m: Pick<CustomerUpdateReadModel, "sendEnabled" | "blockedBy">, canWrite: boolean): SendView {
  // Strict: only a literal `true` from the server shows the control.
  const showSend = m.sendEnabled === true && canWrite;
  const blockedWords = m.blockedBy.filter((b) => b !== "SEND_DISABLED").map((b) => BLOCK_WORD[b] ?? "Sending isn't available for this incident.");
  return { showSend, blockedWords };
}

/** The confirm dialog's message (pinned). */
export const SEND_CONFIRM_MESSAGE = "Sends this in-app message to the customer. It is recorded as an operator action with your reason. Only one update can be sent for this incident.";

// ── Send outcome ────────────────────────────────────────────────────────────

/** What the send route reported, in words. Never a bare "done". */
export function sendOutcomeText(status: number, body: Record<string, unknown>): string {
  if (status === 200 && body.outcome === "sent") return "Sent: the update is in the customer's in-app inbox.";
  if (status === 200 && body.outcome === "not_delivered_preference") return "Approved, but not delivered (customer preference): the customer has turned these notifications off.";
  switch (body.code) {
    case "NOT_AVAILABLE": return "Sending incident updates isn't available here. Nothing was sent.";
    case "ALREADY_SENT": return "Not sent: an update was already sent for this incident.";
    case "REAUTH_NOTICE_RECENT": return "Not sent: a reconnect request went out in the last 24 h.";
    case "DRAFT_CHANGED": return "Not sent: the incident changed since the draft was read. Reload and review it again.";
    case "LINT_FAILED": return "Not sent: the paragraph didn't pass the message checks.";
    case "NOT_ELIGIBLE": return "Not sent: only a live incident can carry a customer update.";
    case "NO_RECIPIENT": return "Not sent: the customer can't receive updates.";
    case "SEND_FAILED": return "The approval was recorded but the update couldn't be created. Nothing was sent.";
    case "AUDIT_FAILED": return "The approval couldn't be recorded. Nothing was sent.";
    case "VALIDATION": return "Not sent: choose a reason and check the paragraph.";
  }
  if (status === 403) return "Not authorized (write access with a fresh sign-in is required). Nothing was sent.";
  if (status === 429) return "Too many actions. Wait a minute and try again. Nothing was sent.";
  return `Not sent (${status}).`;
}

// ── Delivery status ─────────────────────────────────────────────────────────

export const DELIVERY_STATUS_WORD: Readonly<Record<string, string>> = {
  QUEUED: "Queued", SCHEDULED: "Scheduled", ACCEPTED: "Delivered to inbox", CAPTURED: "Held (test environment)",
  SUPPRESSED: "Not sent", CANCELLED: "Cancelled", FAILED: "Failed", DEAD: "Failed (gave up)",
  DELIVERED: "Delivered", BOUNCED: "Bounced", COMPLAINED: "Marked as spam",
};

export const DELIVERY_REASON_WORD: Readonly<Record<string, string>> = {
  PREFERENCE_OFF: "customer preference", NO_RECIPIENT: "no recipient", OBSOLETE: "no longer relevant",
  DEDUPE_OPEN: "a similar message is already open", FREQUENCY_CAP: "frequency limit", ELIGIBILITY_FAILED: "not eligible",
  ADMISSION_REFUSED: "not admitted", ACCOUNT_RESTRICTED: "account restricted", BETA_LIFECYCLE: "beta access state",
  ENTITLEMENT: "plan does not include it", PROVIDER_FREEZE: "sending paused", ENVIRONMENT_GUARD: "test environment",
  RESERVED_DOMAIN: "test address", AUTOMATION_PAUSED: "automation paused", STORM_BREAKER: "sending paused",
  RATE_LIMITED: "rate limit", RATE_LIMIT_UNVERIFIED: "rate limit unverified", SHIPPED_OFF: "channel off",
};

export const DELIVERY_ERROR_WORD: Readonly<Record<string, string>> = {
  RENDER: "the message couldn't be built", TIMEOUT: "timed out", NO_TRANSPORT: "no delivery channel",
  PROVIDER: "the provider refused it", STORE: "the inbox couldn't be written", PREFERENCE_READ: "preferences couldn't be read",
  RECIPIENT_LOOKUP: "recipient couldn't be looked up",
};

export const DELIVERY_CHANNEL_WORD: Readonly<Record<string, string>> = { IN_APP: "In-app", EMAIL: "Email", OPERATOR_EMAIL: "Operator email" };

export interface DeliveryLine { key: string; title: string; detail: string }

/** One row in words: "In-app · Not sent (customer preference)" + "attempt 1 · 3 h ago". */
export function deliveryLine(r: DeliveryRow, now: Date): DeliveryLine {
  const status = DELIVERY_STATUS_WORD[r.status] ?? "Unknown status";
  const why = r.reason ? (DELIVERY_REASON_WORD[r.reason] ?? "other reason") : r.errorCode ? (DELIVERY_ERROR_WORD[r.errorCode] ?? "other error") : null;
  const title = `${DELIVERY_CHANNEL_WORD[r.channel] ?? "Other channel"} · ${status}${why ? ` (${why})` : ""}`;
  const detail = [`attempt ${r.attempt}`, r.mode === "TEST" ? "test" : null, relativeAgo(r.createdAt, now)].filter((x): x is string => !!x).join(" · ");
  return { key: `${r.channel}:${r.createdAt}:${r.attempt}`, title, detail };
}

// ── The collapsed one-line summary ──────────────────────────────────────────

export function summaryLine(m: CustomerUpdateReadModel | null, now: Date): string {
  if (!m) return "Reading…";
  if (m.dedupe.episode.sent) return `Sent ${m.dedupe.episode.sentAt ? relativeAgo(m.dedupe.episode.sentAt, now) : "earlier"}`;
  if (m.dedupe.reauthNotice?.blocksSend) return "On hold: reconnect request in the last 24 h";
  if (!m.recipient.attributed) return "No attributed customer";
  if (!m.eligible) return "Not available for this incident";
  return m.sendEnabled ? "Draft ready" : "Draft ready · preview only";
}
