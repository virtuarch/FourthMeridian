/**
 * lib/platform/incidents/customer-update/core.ts  (Incident customer update, PR-C1 — PURE, client-safe)
 *
 * Owner yes; S2 ruling 09gg (c). An operator-drafted, operator-APPROVED customer
 * update for one Platform Ops incident: a FIXED template
 * (lib/notifications/incident-customer-update.ts) around ONE editable paragraph.
 * This module is the deterministic part, with no I/O and no AI:
 *
 *   draftIncidentCustomerUpdate(dto)   the paragraph the drawer pre-fills, chosen
 *                                      by the incident's remedy class
 *                                      (lib/platform/incidents/explanations.ts),
 *                                      or the recovered copy when — and only when —
 *                                      recovery is VERIFIED;
 *   lintIncidentCustomerUpdate(text, { verifiedRecovery, institution })
 *                                      the gate every paragraph passes before it is
 *                                      previewed or sent;
 *   reauthNoticeState / episodeSendState
 *                                      the dedupe facts the read model exposes and
 *                                      the send enforces (one sent update per
 *                                      episode; none within 24 h of a reconnect-
 *                                      request notice, created OR suppressed_duplicate).
 *
 * LINT CLASSES (each is a refusal; codes only — the text is never echoed):
 *   EMPTY · TOO_LONG (> 600 characters) · LINE_BREAK (one paragraph only) ·
 *   MARKUP (< > { } — the frame is code, the paragraph is plain text) ·
 *   LINK (URL, bare domain, email address, phone number — the content lexicon's
 *   linkHits / softLinkHits) · FIGURE (any digit, currency symbol or code,
 *   percentage, or spelled-out amount — figureTokens) · IDENTIFIER (account /
 *   card / routing / member identifiers, the incident's own institution name,
 *   provider error codes, opaque ids, addresses and credential words) ·
 *   ADVICE (the content advice + financial-claim lexicons) · PROMISE ("fix",
 *   "fixed", "resolved", "restored", "back to normal" …) — allowed ONLY when the
 *   incident's recovery is verified.
 */

import { adviceHits, claimHits, figureTokens, hasPiiLike, linkHits, normalise, softLinkHits } from "@/lib/notifications/content/lint";
import { INCIDENT_UPDATE_PARAGRAPH_MAX } from "@/lib/notifications/incident-customer-update";
import type { RemedyClass } from "../explanations";
import type { IncidentDetailDTO } from "../investigation-dto";

export { INCIDENT_UPDATE_PARAGRAPH_MAX };

/** The registry type every send creates (lib/notifications/registry.ts). */
export const INCIDENT_CUSTOMER_UPDATE_TYPE = "INCIDENT_CUSTOMER_UPDATE" as const;

/** No update within this long after a reconnect-request notice for the same connection (S2 09gg c). */
export const REAUTH_NOTICE_QUIET_MS = 24 * 60 * 60 * 1000;

/** The reconnect-request outcomes that put a notice in front of the customer (action-context.ts ReauthRequestOutcome). */
export const BLOCKING_REAUTH_OUTCOMES: readonly string[] = ["created", "suppressed_duplicate"];

// ── The deterministic draft ──────────────────────────────────────────────────

/** What a draft is chosen by: the remedy class, the verified recovery, or neither. */
export type DraftClass = RemedyClass | "recovered" | "general";

/**
 * One paragraph per class. Plain language, no figures, no identifiers, no advice,
 * and no "fixed / resolved / restored" — except the recovered copy, which is only
 * ever drafted when recovery is verified. Every entry passes the lint (pinned).
 */
export const DRAFTS: Readonly<Record<DraftClass, string>> = {
  "customer-reconnect":
    "Your bank is asking you to sign in again before it will share data with us, so this connection has stopped updating. " +
    "Open the Connections page, choose Reconnect, and sign in to your bank. Your history is kept.",
  "customer-re-add":
    "This connection was disconnected at your bank or by our data provider, so it can no longer update. " +
    "If you want it connected, add it again from the Connections page. Your history is kept.",
  "server-retry":
    "Your bank or our data provider is having a temporary problem, so this connection may not update for a while. " +
    "You don't need to do anything. We will keep trying automatically.",
  investigate:
    "We noticed a problem updating one of your connections and our team is looking into it. " +
    "You don't need to do anything right now. We will let you know if anything is needed from you.",
  general:
    "We noticed a problem updating one of your connections. Our team has been looking into it, " +
    "and we will let you know if anything is needed from you.",
  recovered:
    "The problem we noticed with one of your connections has been resolved, and it is updating normally again. " +
    "You don't need to do anything.",
};

/** The incident fields the draft and the lint read — a CS IncidentDetailDTO satisfies it. */
export type CustomerUpdateIncident = Pick<IncidentDetailDTO, "incident" | "summary" | "affected">;

/**
 * VERIFIED recovery: the incident is closed as AUTOMATIC_RECOVERY with evidence
 * (verdict closure "recovered" — a SUCCEEDED proof; a skip is never proof). An
 * operator resolve, a removed connection, a legacy resolved row or an open
 * incident with a proof that has not closed it is NOT verified.
 */
export function verifiedRecoveryOf(dto: Pick<IncidentDetailDTO, "incident">): boolean {
  return dto.incident.closure === "recovered";
}

export interface IncidentCustomerUpdateDraft {
  paragraph: string;
  draftClass: DraftClass;
  verifiedRecovery: boolean;
}

/** PURE + deterministic: the same incident always drafts the same paragraph. */
export function draftIncidentCustomerUpdate(dto: CustomerUpdateIncident): IncidentCustomerUpdateDraft {
  const verifiedRecovery = verifiedRecoveryOf(dto);
  const draftClass: DraftClass = verifiedRecovery ? "recovered" : (dto.summary.remedy ?? "general");
  return { paragraph: DRAFTS[draftClass], draftClass, verifiedRecovery };
}

// ── The lint ─────────────────────────────────────────────────────────────────

export const LINT_CODES = ["EMPTY", "TOO_LONG", "LINE_BREAK", "MARKUP", "LINK", "FIGURE", "IDENTIFIER", "ADVICE", "PROMISE"] as const;
export type LintCode = (typeof LINT_CODES)[number];

export interface LintResult {
  ok: boolean;
  /** Distinct refusal codes, in LINT_CODES order. Codes only — the text is never echoed. */
  codes: LintCode[];
  length: number;
  max: number;
}

/** Account / card / member identifier vocabulary (matched on normalised text). */
const IDENTIFIER_TERMS: readonly RegExp[] = [
  /\baccount (?:number|no|id|ending)\b/, /\bacct\b/, /\brouting\b/, /\b(?:card|member|customer|user|item|connection) (?:number|no|id)\b/,
  /\bcard ending\b/, /\bending in\b/, /\blast (?:four|4)\b/, /\biban\b/, /\bswift\b/, /\bsort code\b/, /\baccess token\b/,
  /\bssn\b/, /\bsocial security\b/, /#/,
];
/** A provider error code ("ITEM_LOGIN_REQUIRED") — read on the raw text. */
const PROVIDER_CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
/** An opaque id (cuid / uuid-ish run of 16+ letters and digits or hex with dashes). */
const OPAQUE_ID = /\b(?=[a-z0-9-]*\d)[a-z0-9]{16,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-/i;
const MARKUP = /[<>{}]/;
/** Promise words. "fixture", "prefix", "resolution" and "restoration" are not promises and do not match. */
const PROMISE = /\b(?:fix|fixes|fixed|fixing|resolve|resolves|resolved|resolving|restore|restores|restored|restoring|repair|repaired|back to normal|working (?:normally )?again|up and running)\b/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the text names the incident's own institution (word-bounded, case-folded). */
function namesInstitution(text: string, institution: string | null | undefined): boolean {
  const name = institution ? normalise(institution).trim() : "";
  if (name.length < 3) return false;
  return new RegExp(`(?:^|[^a-z0-9])${escapeRe(name)}(?:$|[^a-z0-9])`).test(normalise(text));
}

/** PURE — every refusal class this paragraph trips. ok ⇔ no code. */
export function lintIncidentCustomerUpdate(
  text: string,
  opts: { verifiedRecovery: boolean; institution?: string | null },
): LintResult {
  const codes = new Set<LintCode>();
  const trimmed = text.trim();
  if (trimmed === "") codes.add("EMPTY");
  if (trimmed.length > INCIDENT_UPDATE_PARAGRAPH_MAX) codes.add("TOO_LONG");
  // One paragraph: no line or paragraph break, no control or bidi character.
  if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/.test(trimmed)) codes.add("LINE_BREAK");
  if (MARKUP.test(text)) codes.add("MARKUP");
  if (linkHits(text).length > 0 || softLinkHits(text).length > 0) codes.add("LINK");
  if (figureTokens(text).length > 0 || /\d/.test(normalise(text))) codes.add("FIGURE");
  const t = normalise(text);
  if (IDENTIFIER_TERMS.some((re) => re.test(t)) || PROVIDER_CODE.test(text) || OPAQUE_ID.test(text)
    || hasPiiLike(text) || namesInstitution(text, opts.institution)) codes.add("IDENTIFIER");
  if (adviceHits(text).length > 0 || claimHits(text).length > 0) codes.add("ADVICE");
  if (!opts.verifiedRecovery && PROMISE.test(t.replace(/[’']/g, "'"))) codes.add("PROMISE");
  const ordered = LINT_CODES.filter((c) => codes.has(c));
  return { ok: ordered.length === 0, codes: ordered, length: trimmed.length, max: INCIDENT_UPDATE_PARAGRAPH_MAX };
}

// ── Dedupe facts ─────────────────────────────────────────────────────────────

/** One CONNECTION_REAUTH_REQUESTED audit row for the incident's connection: its recorded outcome and time. */
export interface ReauthNoticeFact { outcome: string | null; at: Date }

export interface ReauthNoticeState {
  /** The recorded request-reauth outcome (created | suppressed_duplicate | marked_not_notified | no_change). */
  outcome: string;
  at: string;
  /** True for created / suppressed_duplicate inside the 24 h window: no update may be sent. */
  blocksSend: boolean;
  /** When the quiet window ends (at + 24 h); null when it does not block. */
  quietUntil: string | null;
}

/**
 * The reconnect-request notice the drawer shows, from the rows inside the last
 * 24 h (any outside it are ignored): the newest BLOCKING one if any exists,
 * else the newest of any outcome; null when there is none.
 */
export function reauthNoticeState(rows: readonly ReauthNoticeFact[], now: Date): ReauthNoticeState | null {
  const since = now.getTime() - REAUTH_NOTICE_QUIET_MS;
  const inWindow = rows
    .filter((r) => r.at.getTime() >= since && r.at.getTime() <= now.getTime() && typeof r.outcome === "string")
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const blocking = inWindow.find((r) => BLOCKING_REAUTH_OUTCOMES.includes(r.outcome as string));
  const pick = blocking ?? inWindow[0];
  if (!pick) return null;
  return {
    outcome: pick.outcome as string,
    at: pick.at.toISOString(),
    blocksSend: !!blocking,
    quietUntil: blocking ? new Date(blocking.at.getTime() + REAUTH_NOTICE_QUIET_MS).toISOString() : null,
  };
}

/** One ledger row of this incident's INCIDENT_CUSTOMER_UPDATE sends (codes and status only). */
export interface EpisodeDeliveryFact {
  channel: string;
  status: string;
  reason: string | null;
  errorCode: string | null;
  attempt: number;
  mode: string;
  createdAt: Date;
  acceptedAt: Date | null;
}

export interface EpisodeSendState {
  /** An update for this episode was ACCEPTED into the customer's inbox (a LIVE in-app row). */
  sent: boolean;
  sentAt: string | null;
}

/** "Sent" = a LIVE IN_APP row ACCEPTED for this incident. A failed or preference-skipped attempt is not sent. */
export function episodeSendState(rows: readonly EpisodeDeliveryFact[]): EpisodeSendState {
  const accepted = rows
    .filter((r) => r.channel === "IN_APP" && r.status === "ACCEPTED" && r.mode !== "TEST")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return { sent: accepted.length > 0, sentAt: accepted[0] ? (accepted[0].acceptedAt ?? accepted[0].createdAt).toISOString() : null };
}

export type SendBlock = "SEND_DISABLED" | "NO_RECIPIENT" | "NOT_ELIGIBLE" | "ALREADY_SENT" | "REAUTH_NOTICE_RECENT";

/** Why a send would be refused right now (the read model's `blockedBy`), in check order. Empty ⇒ it may be sent. */
export function sendBlocks(args: {
  sendEnabled: boolean;
  eligible: boolean;
  recipient: boolean;
  episode: EpisodeSendState;
  reauthNotice: ReauthNoticeState | null;
}): SendBlock[] {
  const out: SendBlock[] = [];
  if (!args.sendEnabled) out.push("SEND_DISABLED");
  if (!args.eligible) out.push("NOT_ELIGIBLE");
  if (!args.recipient) out.push("NO_RECIPIENT");
  if (args.episode.sent) out.push("ALREADY_SENT");
  if (args.reauthNotice?.blocksSend) out.push("REAUTH_NOTICE_RECENT");
  return out;
}
