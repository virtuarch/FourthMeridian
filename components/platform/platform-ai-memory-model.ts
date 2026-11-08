/**
 * components/platform/platform-ai-memory-model.ts  (Platform AI operational memory — the client model, PURE)
 *
 * Design v2 §5 (UI), §9 (the notice, verbatim, B4), and the S2 MEMORY BUILD
 * CHECKLIST: once memory is effective, the #481 short line "Read-only · Sent to
 * OpenAI · Chats hidden after 7 days · Don't enter personal details" is FALSE
 * (Remember writes a row), so the composer shows PLATFORM_AI_MEMORY_LINE instead.
 * Flag off ⇒ the conversations line, unchanged. Both are pinned by tests.
 */

import { PLATFORM_AI_PROVIDER, PLATFORM_AI_RETENTION_DAYS_CLIENT } from "./platform-ai-conversations-model";

/**
 * The short line while memory is effective (S2 checklist + S2 wording 2026-11-08): "Read-only" would
 * be false (Remember writes a row). "Can't" keeps the straight apostrophe the existing copy uses for
 * can't (DELETE_CONFIRM_COPY, UNREADABLE_COPY); "Don’t" keeps the line's typographic one. Pinned.
 */
export const PLATFORM_AI_MEMORY_LINE =
  `Can't change anything · Remembers only what you choose · Sent to ${PLATFORM_AI_PROVIDER} · Chats hidden after ${PLATFORM_AI_RETENTION_DAYS_CLIENT} days · Don’t enter personal details`;

/** §9 — the Platform AI memory notice, VERBATIM (B4). Changing it needs a new owner approval and S3's claim check. */
export const PLATFORM_AI_MEMORY_NOTICE_TITLE = "Platform AI memory.";
export const PLATFORM_AI_MEMORY_NOTICE =
  "When you choose Remember, Platform AI keeps a short item about an issue: its type; references to the records involved; an optional note you write (up to 140 characters); when you saved it. It does not keep your conversation. Notes that contain emails, long numbers, amounts or customer identifiers are blocked, and you're responsible for what you write in a note. Records are referenced, not copied, and are re-read with your current access each time. Items for live status expire after 72 hours, and every other item after at most 30 days. Using an item does not extend it; only you can renew it. Saved items are always shown as of the time you saved them, and answers re-check live data. To answer your questions, saved items are sent to our AI provider along with your request. You can see and delete your items at any time: a deleted item is hidden immediately and removed at the next scheduled purge. If you lose access to an area, its items stop being shown and are removed at the next scheduled purge. Conversations are encrypted, hidden after 7 days and removed at the next scheduled purge. Removed data may remain in backups until those backups expire.";
/**
 * §9 placement: the panel header's "How memory works" control expands the FULL notice
 * inline (this region id). The public privacy page is behind the marketing boundary
 * (marketing imports only, byte-identical site/ copy), so its §Platform AI text is
 * an owner privacy-reconcile item, not rendered by this flag-gated code.
 */
export const PLATFORM_AI_MEMORY_NOTICE_ID = "platform-ai-memory-notice";

/** §5 — the panel header line, verbatim. */
export const PLATFORM_AI_MEMORY_PANEL_HEADER = "Memory is what you asked Platform AI to remember. It is not live data. Answers always re-check live records.";
export const PLATFORM_AI_MEMORY_RENEW_CHANGED = "This has changed; save a new item instead";

export const PLATFORM_AI_MEMORY_URL = "/api/platform/ai/memory";
export const PLATFORM_AI_MEMORY_CONFIRM_URL = "/api/platform/ai/memory/confirm";
export const PLATFORM_AI_MEMORY_REMEMBER_URL = "/api/platform/ai/memory/remember";
export const memoryFactUrl = (id: string) => `${PLATFORM_AI_MEMORY_URL}/${encodeURIComponent(id)}`;
export const memoryRenewUrl = (id: string) => `${memoryFactUrl(id)}/renew`;

export const MEMORY_TYPE_LABEL: Readonly<Record<string, string>> = {
  WATCHING_ISSUE: "Watching", OPERATIONAL_STATE: "Live status", FOLLOW_UP: "Follow up", OPERATOR_PREFERENCE: "Preference",
};
export const MEMORY_CONCERN_LABEL: Readonly<Record<string, string>> = {
  RECURRING_FAILURE: "Recurring failure", DEGRADATION: "Degradation", COST_SPIKE: "Cost spike",
  CUSTOMER_IMPACT: "Customer impact", AWAITING_FIX: "Awaiting fix", MONITOR_ONLY: "Monitor only",
};
export const MEMORY_BADGE_LABEL: Readonly<Record<string, string>> = {
  UNCHANGED: "Unchanged", CHANGED: "Changed", UPDATED: "Updated", GONE: "Gone", UNVERIFIED: "Unverified",
};
export const MEMORY_TTL_LABEL: Readonly<Record<string, string>> = { H24: "24 hours", H72: "72 hours", D7: "7 days", D30: "30 days" };

// ── Defensive parsing ───────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export interface ClientMemoryRow {
  id: string; type: string; subject: string | null; concern: string | null; note: string | null;
  noted: string; expiresAt: string; badge: string; canRenew: boolean;
}
export interface ClientMemoryArea { area: string; areaLabel: string; facts: ClientMemoryRow[] }

/** S2 C5: facts beyond the panel's newest 50 (a count only). */
export const parsePanelMore = (body: unknown): number => (isObj(body) && typeof body.more === "number" && body.more > 0 ? Math.floor(body.more) : 0);

export function parsePanel(body: unknown): ClientMemoryArea[] | null {
  if (!isObj(body) || !Array.isArray(body.areas)) return null;
  const out: ClientMemoryArea[] = [];
  for (const a of body.areas) {
    if (!isObj(a) || !str(a.area) || !str(a.areaLabel) || !Array.isArray(a.facts)) return null;
    const facts: ClientMemoryRow[] = [];
    for (const f of a.facts) {
      if (!isObj(f) || !str(f.id) || !str(f.type) || !str(f.noted) || !str(f.expiresAt) || !str(f.badge)) return null;
      facts.push({
        id: f.id as string, type: f.type as string, subject: str(f.subject), concern: str(f.concern), note: str(f.note),
        noted: f.noted as string, expiresAt: f.expiresAt as string, badge: f.badge as string, canRenew: f.canRenew === true,
      });
    }
    out.push({ area: a.area as string, areaLabel: a.areaLabel as string, facts });
  }
  return out;
}

export interface ClientMemoryProposal {
  token: string; factType: string; concern: string | null; subjectLabel: string; note: string | null; ttlChoices: string[];
}

export function parseProposal(v: unknown): ClientMemoryProposal | null {
  if (!isObj(v) || !str(v.token) || !str(v.factType) || !str(v.subjectLabel) || !Array.isArray(v.ttlChoices)) return null;
  const ttl = v.ttlChoices.filter((t): t is string => typeof t === "string" && t in MEMORY_TTL_LABEL);
  if (ttl.length === 0) return null;
  return { token: v.token as string, factType: v.factType as string, concern: str(v.concern), subjectLabel: v.subjectLabel as string, note: str(v.note), ttlChoices: ttl };
}

/** "expires 15 Nov 2026" (UTC), from an ISO string. */
export function expiresLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `expires ${d.getUTCDate()} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
