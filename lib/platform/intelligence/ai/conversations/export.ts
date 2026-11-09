/**
 * lib/platform/intelligence/ai/conversations/export.ts  (PR D — the subject-access projection, PURE)
 *
 * Design §7.3 (S2 B6; S2 REQUIRED 4; the S2 STRICT export ruling, which
 * supersedes Q5). The operator's own data export (lib/export/assemble.ts)
 * carries their LIVE Platform AI conversations. The rows arrive from the one
 * data module (./store.ts readConversationsForExport), which has ALREADY split
 * them by the areas the operator holds today:
 *
 *   · a HELD area   ⇒ every message: the questions, and the answers as rendered
 *     text with their citations and code-written notes;
 *   · a LOST area   ⇒ NO content at all — no question, answer, title or derived
 *     label. Its messages were never read; the bundle carries one line per
 *     area: "N conversation(s) in <area> omitted: you no longer have access"
 *     (singular for 1),
 *     and the manifest a count per area.
 *   · soft-deleted conversations never leave the database.
 *
 * "Held" is decided by the caller from ONE directory read (ACTIVE grants, the
 * list route's rule — no per-area fresh guard, so no false OBS-009 denial rows),
 * and is EMPTY when operator 2FA is enforced and the operator has none (the
 * guard's own SEC-PLAT-1 rule). Stored links are exported as their TEXT only.
 *
 * No database, no key, no env, no clock, no I/O.
 */

import type { PlatformArea } from "@prisma/client";
import { PLATFORM_AREAS } from "@/lib/platform/policy";
import type { StoredAnswerV1 } from "./answer";
import type { ExportConversationRecord, ExportConversationsRead, MessageRecord } from "./store";

export interface ExportPlatformAiMessage {
  role: "USER" | "ASSISTANT";
  status: "PENDING" | "COMPLETE" | "FAILED";
  createdAt: string;
  completedAt: string | null;
  /** The question, or the answer as rendered text. Null while PENDING, for a FAILED reply, or when unreadable. */
  text: string | null;
  /** True when a stored value exists but could not be decrypted / parsed (never exported as raw text). */
  unavailable: boolean;
  failureCode: string | null;
  /** ASSISTANT only (held areas): the metrics the answer cited, as shown. */
  citations?: { metric: string; label: string; window: string }[];
  /** ASSISTANT only (held areas): the deterministic, code-written notes. */
  notes?: string[];
}

export interface ExportPlatformAiConversation {
  id: string;
  area: PlatformArea;
  areaLabel: string;
  createdAt: string;
  lastActivityAt: string;
  messages: ExportPlatformAiMessage[];
}

/** One line per LOST area: a count and the S2 wording — never any content. */
export interface ExportPlatformAiOmission {
  area: PlatformArea;
  areaLabel: string;
  count: number;
  note: string;
}

export interface PlatformAiExportSection {
  conversations: ExportPlatformAiConversation[];
  omitted: ExportPlatformAiOmission[];
}

const areaLabel = (area: PlatformArea) => PLATFORM_AREAS[area]?.label ?? area;

/** The S2 STRICT omission line, per lost area. */
export const omittedConversationsNote = (count: number, area: PlatformArea) =>
  `${count} ${count === 1 ? "conversation" : "conversations"} in ${areaLabel(area)} omitted: you no longer have access`;

/** A stored answer as plain rendered text: text, figure and link spans in order (links by their text only). */
export function renderAnswerText(a: StoredAnswerV1): string {
  return a.segments.map((s) => (s.kind === "correction" || s.kind === "note" ? `${s.text} ` : s.text)).join("");
}

function exportMessage(m: MessageRecord): ExportPlatformAiMessage {
  const base = {
    role: m.role, status: m.status,
    createdAt: m.createdAt.toISOString(),
    completedAt: m.completedAt ? m.completedAt.toISOString() : null,
    unavailable: m.unreadable,
    failureCode: m.failureCode,
  };
  if (m.role === "USER") return { ...base, text: typeof m.content === "string" ? m.content : null };
  const answer = m.content !== null && typeof m.content !== "string" ? m.content : null;
  return {
    ...base,
    text: answer ? renderAnswerText(answer) : null,
    citations: answer ? answer.citations.map((c) => ({ metric: c.metric, label: c.label, window: c.window })) : [],
    notes: answer ? [...answer.notes] : [],
  };
}

const exportConversation = (c: ExportConversationRecord): ExportPlatformAiConversation => ({
  id: c.id,
  area: c.area,
  areaLabel: areaLabel(c.area),
  createdAt: c.createdAt.toISOString(),
  lastActivityAt: c.lastActivityAt.toISOString(),
  messages: c.messages.map(exportMessage),
});

/**
 * PURE. The export section for what the data module read: held conversations
 * in full, lost areas as counts. Defence in depth: a conversation whose area is
 * not held is DROPPED here too (counted, never exported), even if a caller
 * passed one.
 */
export function projectPlatformAiConversationsForExport(
  read: ExportConversationsRead,
  heldAreas: ReadonlySet<PlatformArea>,
): PlatformAiExportSection {
  const counts = new Map<PlatformArea, number>();
  for (const o of read.omitted) counts.set(o.area, (counts.get(o.area) ?? 0) + o.count);
  const conversations: ExportPlatformAiConversation[] = [];
  for (const c of read.conversations) {
    if (heldAreas.has(c.area)) conversations.push(exportConversation(c));
    else counts.set(c.area, (counts.get(c.area) ?? 0) + 1);
  }
  const omitted = [...counts]
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([area, count]) => ({ area, areaLabel: areaLabel(area), count, note: omittedConversationsNote(count, area) }));
  return { conversations, omitted };
}
