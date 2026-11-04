/**
 * lib/platform/intelligence/ai/conversations/turn.ts  (one conversation turn — PURE apart from the injected seams)
 *
 * Design §4 (history), §5 (the turn between transaction 1 and transaction 2).
 * The turn-integration follow-up to #424:
 *
 *   1. history   the ONE conversation's prior COMPLETE exchanges, assembled by
 *                assemblePlatformAiHistory: untrusted context, prior figures
 *                MASKED (markers, never values), earlier evidence refs re-filtered
 *                through the CURRENT token (the binding the route built from the
 *                conversation's own area guard), ≤ 10 messages / ≈ 3k tokens with
 *                whole exchanges dropped oldest first;
 *   2. the turn  v0's runPlatformAiTurn, UNCHANGED in its defences: tools close
 *                over the binding, placeholders resolve only against THIS turn's
 *                envelopes, links only to this turn's resolver hrefs, the same
 *                rounds / tool calls / 24k token ceiling;
 *   3. settle    the rendered answer as a StoredAnswerV1 (figures typed with their
 *                metric key and window, links as registry PAGE IDS, never hrefs)
 *                plus evidenceRefs (metric keys + windows, page ids — NO values);
 *                a thrown provider error ⇒ FAILED with a closed code.
 *
 * Nothing here touches a database, a key, the clock or the provider directly.
 * It never throws: every failure becomes a FAILED outcome with an enum code.
 */

import {
  PLATFORM_AI_TURN_TIMEOUT_MS, runPlatformAiTurn, traceLine,
  type PlaceholderVerdict, type PlatformAiAnswer, type PlatformAiBinding, type PlatformAiGenerate, type PlatformAiTurnRecord,
} from "../core";
import {
  EVIDENCE_REFS_MAX, REF_ID_SHAPE, STORED_ANSWER_VERSION, STORED_CITATIONS_MAX, STORED_NOTES_MAX, STORED_SEGMENTS_MAX, STORED_TEXT_MAX,
  isStoredAnswer, type EvidenceRef, type StoredAnswerV1, type StoredSegment,
} from "./answer";
import { assemblePlatformAiHistory, type AssembledHistory, type HistoryMessage, type HistoryScope } from "./history";

/** The settle outcome (store.ts SettleOutcome, restated here so this module stays free of the data module). */
export type ConversationTurnOutcome =
  | { status: "COMPLETE"; answer: StoredAnswerV1; evidenceRefs: readonly EvidenceRef[] }
  | { status: "FAILED"; failureCode: "TIMEOUT" | "PROVIDER" | "KILL_SWITCH" };

/** What the CURRENT token can see, for history's earlier-evidence filter: the binding's own accessors. */
export function historyScopeFor(binding: Pick<PlatformAiBinding, "describeMetric" | "resolvePage">): HistoryScope {
  return {
    describeMetric: (id) => binding.describeMetric(id),
    pageVisible: (id) => binding.resolvePage(id) !== null,
  };
}

const clip = (t: string, max: number) => (t.length <= max ? t : t.slice(0, max));
const validWindow = (w: number | string | null): number | string | null =>
  w === null ? null : typeof w === "number" ? (Number.isInteger(w) && w > 0 && w <= 3660 ? w : null) : w.length <= 120 ? w : null;

/**
 * The answer the operator saw, as the stored shape (design §2.5, "stored as
 * rendered"): text, FIGURE spans (server-rendered text + metric key + window),
 * and links as the registry page id they were resolved from (an href with no
 * known page id becomes plain text — never stored as a URL).
 */
export function storedAnswerOf(result: PlatformAiAnswer, record: Pick<PlatformAiTurnRecord, "typed" | "pages">): StoredAnswerV1 {
  const segs: StoredSegment[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = segs[segs.length - 1];
    if (last && last.kind === "text") last.text = clip(last.text + text, STORED_TEXT_MAX);
    else segs.push({ kind: "text", text: clip(text, STORED_TEXT_MAX) });
  };
  for (const s of record.typed) {
    if (s.kind === "figure") {
      if (s.text.length <= 120 && REF_ID_SHAPE.test(s.metric)) segs.push({ kind: "figure", text: s.text, metric: s.metric, window: validWindow(s.window) });
      else pushText(s.text);
    } else if (s.kind === "link") {
      const page = record.pages.get(s.href);
      if (page && REF_ID_SHAPE.test(page.id) && s.text.length <= 200) segs.push({ kind: "link", text: s.text, page: page.id, params: { ...page.params } });
      else pushText(s.text);
    } else pushText(s.text);
  }
  return {
    v: STORED_ANSWER_VERSION,
    segments: segs.slice(0, STORED_SEGMENTS_MAX),
    citations: result.citations.slice(0, STORED_CITATIONS_MAX)
      .filter((c) => REF_ID_SHAPE.test(c.metric))
      .map((c) => ({ metric: c.metric, label: clip(c.label, 200), window: clip(c.window, 200) })),
    notes: result.notes.slice(0, STORED_NOTES_MAX).map((n) => clip(n, 400)),
    stop: result.stop,
  };
}

/**
 * What the turn READ, as pointers (S2 B1, Q7): every metric key with the window it
 * was read with (window.days; null = the default or a fixed window) and every
 * registry page id the turn resolved. NO value, status, reason, href or argument.
 */
export function evidenceRefsOf(record: Pick<PlatformAiTurnRecord, "metricsRead" | "pages">): EvidenceRef[] {
  const out: EvidenceRef[] = [];
  const seen = new Set<string>();
  for (const m of record.metricsRead) {
    const w = m.days !== null && Number.isInteger(m.days) && m.days > 0 && m.days <= 3660 ? m.days : null;
    const key = `m|${m.metric}|${w ?? ""}`;
    if (seen.has(key) || !REF_ID_SHAPE.test(m.metric)) continue;
    seen.add(key);
    out.push({ k: "m", id: m.metric, w });
  }
  for (const p of record.pages.values()) {
    const key = `p|${p.id}`;
    if (seen.has(key) || !REF_ID_SHAPE.test(p.id)) continue;
    seen.add(key);
    out.push({ k: "p", id: p.id });
  }
  return out.slice(0, EVIDENCE_REFS_MAX);
}

export interface ConversationTurnInput {
  conversationId: string;
  /** The stored, ALREADY-SCRUBBED question (one scrub for both sinks, S2 B3). */
  question: string;
  /** Built by the route from the conversation's OWN area guard (FRESH), never from the request or the row. */
  binding: PlatformAiBinding;
  /** The conversation's stored COMPLETE messages (store.loadConversationHistory). */
  history: readonly HistoryMessage[];
  generate: PlatformAiGenerate;
  model: string;
  reasoningModel?: boolean;
  classify(err: unknown): "KILL_SWITCH" | "TIMEOUT" | "PROVIDER";
  signal?: AbortSignal;
  /** Metadata-only lines (codes, counts, registry ids — never text or values). */
  onTrace?(line: string): void;
  onUngrounded?(verdict: PlaceholderVerdict, unresolved: number): void;
}

export interface ConversationTurnRun {
  outcome: ConversationTurnOutcome;
  history: AssembledHistory | null;
  /** The provider transcript (tests only; the route never logs or stores it). */
  transcript: unknown[] | null;
  /** The v0 result (tests only). */
  result: PlatformAiAnswer | null;
}

/** Run ONE conversation turn. Never throws: a provider failure, a timeout or an unstorable answer ⇒ FAILED with a code. */
export async function runConversationTurn(input: ConversationTurnInput): Promise<ConversationTurnRun> {
  let history: AssembledHistory | null = null;
  try {
    history = assemblePlatformAiHistory({ conversationId: input.conversationId, messages: input.history, scope: historyScopeFor(input.binding) });
    const { result, transcript, record } = await runPlatformAiTurn({
      question: input.question, questionScrubbed: true, history,
      binding: input.binding, generate: input.generate, model: input.model, reasoningModel: input.reasoningModel,
      signal: input.signal ?? AbortSignal.timeout(PLATFORM_AI_TURN_TIMEOUT_MS),
    });
    if (result.grounding.replaced) input.onUngrounded?.(result.grounding.verdict, result.claims.unresolved);
    input.onTrace?.(`${traceLine(result)} history=${history.exchangesUsed}/${history.exchangesUsed + history.exchangesDropped}`);
    const answer = storedAnswerOf(result, record);
    if (!isStoredAnswer(answer)) return { outcome: { status: "FAILED", failureCode: "PROVIDER" }, history, transcript, result };
    return { outcome: { status: "COMPLETE", answer, evidenceRefs: evidenceRefsOf(record) }, history, transcript, result };
  } catch (err) {
    let code: "KILL_SWITCH" | "TIMEOUT" | "PROVIDER";
    try { code = input.classify(err); } catch { code = "PROVIDER"; }
    return { outcome: { status: "FAILED", failureCode: code }, history, transcript: null, result: null };
  }
}
