/**
 * lib/platform/intelligence/ai/conversations/export.ts  (PR D — the subject-access projection, PURE)
 *
 * Design §7.3 "Data export" (S2 B6, Q5 RULED; S2 REQUIRED 4). The operator's
 * own data export (lib/export/assemble.ts) carries their LIVE Platform AI
 * conversations. The rows arrive already decrypted from the one data module
 * (./store.ts readConversationsForExport — soft-deleted conversations never
 * leave the database); this file only decides what of them the bundle carries:
 *
 *   · an area the operator HOLDS today  ⇒ every message: the questions, and the
 *     answers as rendered text with their citations and code-written notes;
 *   · an area the operator has LOST     ⇒ QUESTIONS plus timestamps only. Every
 *     answer is omitted (the answers are platform data the operator may no
 *     longer read), and the conversation says so in `answersOmitted`.
 *
 * "Holds" is decided by the caller from ONE directory read (ACTIVE grants, the
 * list route's rule — no per-area fresh guard, so no false OBS-009 denial rows),
 * and is EMPTY when operator 2FA is enforced and the operator has none (the
 * guard's own SEC-PLAT-1 rule). Stored links are exported as their TEXT only:
 * an href is a live-app navigation, never part of a bundle (and a page id is a
 * registry key, not the operator's data).
 *
 * No database, no key, no env, no clock, no I/O.
 */

import type { PlatformArea } from "@prisma/client";
import { PLATFORM_AREAS } from "@/lib/platform/policy";
import type { StoredAnswerV1 } from "./answer";
import type { ExportConversationRecord, MessageRecord } from "./store";

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
  /** False ⇒ the area was lost: questions and timestamps only. */
  answersIncluded: boolean;
  /** Set exactly when answers were omitted (S2 Q5 wording). */
  answersOmitted: string | null;
  messages: ExportPlatformAiMessage[];
}

export interface PlatformAiExportSection {
  conversations: ExportPlatformAiConversation[];
  /** Conversations whose answers were omitted (a lost area). */
  answersOmittedCount: number;
}

const areaLabel = (area: PlatformArea) => PLATFORM_AREAS[area]?.label ?? area;

/** The S2 Q5 omission note, per conversation. */
export const answersOmittedNote = (area: PlatformArea) => `Answers omitted: you no longer have access to ${areaLabel(area)}.`;

/** A stored answer as plain rendered text: text, figure and link spans in order (links by their text only). */
export function renderAnswerText(a: StoredAnswerV1): string {
  return a.segments.map((s) => s.text).join("");
}

function exportMessage(m: MessageRecord, withAnswer: boolean): ExportPlatformAiMessage {
  const base = {
    role: m.role, status: m.status,
    createdAt: m.createdAt.toISOString(),
    completedAt: m.completedAt ? m.completedAt.toISOString() : null,
    unavailable: m.unreadable,
    failureCode: m.failureCode,
  };
  if (m.role === "USER") return { ...base, text: typeof m.content === "string" ? m.content : null };
  const answer = withAnswer && m.content !== null && typeof m.content !== "string" ? m.content : null;
  return {
    ...base,
    text: answer ? renderAnswerText(answer) : null,
    citations: answer ? answer.citations.map((c) => ({ metric: c.metric, label: c.label, window: c.window })) : [],
    notes: answer ? [...answer.notes] : [],
  };
}

/**
 * PURE. The export section for `rows` (the operator's live conversations) given
 * the areas the operator holds today. A lost area keeps its USER messages only.
 */
export function projectPlatformAiConversationsForExport(
  rows: readonly ExportConversationRecord[],
  heldAreas: ReadonlySet<PlatformArea>,
): PlatformAiExportSection {
  let answersOmittedCount = 0;
  const conversations = rows.map((c): ExportPlatformAiConversation => {
    const held = heldAreas.has(c.area);
    if (!held) answersOmittedCount++;
    return {
      id: c.id,
      area: c.area,
      areaLabel: areaLabel(c.area),
      createdAt: c.createdAt.toISOString(),
      lastActivityAt: c.lastActivityAt.toISOString(),
      answersIncluded: held,
      answersOmitted: held ? null : answersOmittedNote(c.area),
      messages: c.messages.filter((m) => held || m.role === "USER").map((m) => exportMessage(m, held)),
    };
  });
  return { conversations, answersOmittedCount };
}
