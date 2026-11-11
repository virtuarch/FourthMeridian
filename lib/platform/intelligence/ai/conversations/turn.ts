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
 *   3. settle    the rendered answer as a StoredAnswer (figures typed with their
 *                metric key and window, links as registry PAGE IDS, never hrefs;
 *                P4: record spans typed {rk, rid, a, f} — V2, never a value)
 *                plus evidenceRefs (metric keys + windows, page ids, areas read,
 *                record kinds + counts — NO values, NO record ids);
 *   P4 replay    a prior answer's record spans are re-authorized BEFORE history is
 *                assembled (`remint`, the turn boundary: area recheck + revalidate);
 *                only those that pass get a fresh handle of THIS turn — history grants
 *                nothing;
 *                a thrown provider error ⇒ FAILED with a closed code.
 *
 * Nothing here touches a database, a key, the clock or the provider directly.
 * It never throws: every failure becomes a FAILED outcome with an enum code.
 */

import {
  PLATFORM_AI_TURN_TIMEOUT_MS, runPlatformAiTurn, segmentsText, traceLine,
  type PlaceholderVerdict, type PlatformAiAnswer, type PlatformAiBinding, type PlatformAiGenerate, type PlatformAiToolInvoker, type PlatformAiTurnRecord, type PlatformAiTurnTools,
} from "../core";
import {
  EVIDENCE_REFS_MAX, REF_ID_SHAPE, STORED_CITATIONS_MAX, STORED_NOTES_MAX, STORED_RECORDS_MAX, STORED_SEGMENTS_MAX, STORED_TEXT_MAX,
  MEMORY_SPAN_SHAPE, answerIdentityProblems, isStoredAnswer, storableAnswerVersion, storedRecordSegments,
  type EvidenceRef, type StoredAnswer, type StoredRecordSegment, type StoredSegment,
} from "./answer";
import type { TurnRecordLookup } from "../compose/record";
import type { MemoryProposalCard, MemoryTurn } from "../memory/turn";
import type { PlatformAiToolTraceEntry } from "../tools/tool-trace";
import { assemblePlatformAiHistory, type AssembledHistory, type HistoryMessage, type HistoryScope } from "./history";
import { answerReadable } from "./multi-area";
import type { PlatformArea } from "@prisma/client";

/** The settle outcome (store.ts SettleOutcome, restated here so this module stays free of the data module). */
export type ConversationTurnOutcome =
  | { status: "COMPLETE"; answer: StoredAnswer; evidenceRefs: readonly EvidenceRef[]; /** Memory: the confirm card (never stored). */ memoryProposal?: MemoryProposalCard | null; /** S2 09hu G1: response only (never stored). */ toolTrace?: readonly PlatformAiToolTraceEntry[] }
  | { status: "FAILED"; failureCode: "TIMEOUT" | "PROVIDER" | "KILL_SWITCH"; /** S2 09hu G1: response only (never stored). */ toolTrace?: readonly PlatformAiToolTraceEntry[] };

/** What the CURRENT token can see, for history's earlier-evidence filter: the binding's own accessors. */
export function historyScopeFor(binding: Pick<PlatformAiBinding, "describeMetric" | "resolvePage">, reminted?: ReadonlyMap<StoredRecordSegment, string>, heldAreas?: ReadonlySet<PlatformArea>): HistoryScope {
  return {
    describeMetric: (id) => binding.describeMetric(id),
    pageVisible: (id) => binding.resolvePage(id) !== null,
    ...(reminted ? { recordHandle: (seg: StoredRecordSegment) => reminted.get(seg) ?? null } : {}),
    // P4b: a prior answer that read an area not held now replays as "[no longer available]" (conversations/multi-area.ts).
    ...(heldAreas ? { answerVisible: (refs: readonly EvidenceRef[], answer: StoredAnswer) => answerReadable(refs, answer, heldAreas) } : {}),
  };
}

/**
 * P4 — replay re-authz (design v2 §6.3 / §8.2): THIS turn's boundary re-checks each prior
 * record span (its area FRESH, the record still visible) and mints a handle of THIS turn
 * for those that pass. `remint` returns one handle (or null) per input, in order.
 */
export type RecordRemint = (refs: readonly { rk: string; rid: string; a: string }[]) => Promise<(string | null)[]>;

/** The record spans of the replayable prior answers, re-authorized through `remint` (none ⇒ no call). */
async function remintHistory(history: readonly HistoryMessage[], remint: RecordRemint | undefined, heldAreas?: ReadonlySet<PlatformArea>): Promise<Map<StoredRecordSegment, string>> {
  const out = new Map<StoredRecordSegment, string>();
  if (!remint) return out;
  // P4b: an answer that read an area not held now is not replayed at all — none of its spans is re-minted.
  const segs = history.flatMap((m) => (m.role === "ASSISTANT" && m.status === "COMPLETE" && m.content !== null && typeof m.content !== "string" && answerReadable(m.evidenceRefs, m.content, heldAreas) ? storedRecordSegments(m.content) : []));
  if (segs.length === 0) return out;
  let handles: (string | null)[] = [];
  try { handles = await remint(segs.map((x) => ({ rk: x.rk, rid: x.rid, a: x.a }))); } catch { handles = []; }
  segs.forEach((x, i) => { const h = handles[i]; if (typeof h === "string") out.set(x, h); });
  return out;
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
export function storedAnswerOf(result: PlatformAiAnswer, record: Pick<PlatformAiTurnRecord, "typed" | "pages">): StoredAnswer {
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
    } else if (s.kind === "correction" || s.kind === "note") segs.push({ kind: s.kind, text: clip(s.text, STORED_TEXT_MAX) });
    else if (s.kind === "memory") { if (MEMORY_SPAN_SHAPE.test(s.text)) segs.push({ kind: "memory", text: s.text }); }
    // P4: a record span keeps its ref only (kind, id, area, field code) — never a value (V2).
    else if (s.kind === "record") { if (segs.filter((x) => x.kind === "record").length < STORED_RECORDS_MAX) segs.push({ kind: "record", rk: s.rk, rid: s.rid, a: s.a, f: s.f }); }
    else pushText(s.text);
  }
  const segments = segs.slice(0, STORED_SEGMENTS_MAX);
  return {
    v: storableAnswerVersion({ segments, stop: result.stop }),
    segments,
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
export function evidenceRefsOf(record: Pick<PlatformAiTurnRecord, "metricsRead" | "pages" | "areasRead"> & { typed?: PlatformAiTurnRecord["typed"] }): EvidenceRef[] {
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
  // P4 (design v2 §8.1; S2 ruling 3): the areas read and the record KINDS with counts — never a record id.
  const tail: EvidenceRef[] = (record.areasRead ?? []).map((a): EvidenceRef => ({ k: "a", id: a }));
  const kinds = new Map<string, number>();
  for (const t of record.typed ?? []) if (t.kind === "record") kinds.set(t.rk, Math.min(STORED_RECORDS_MAX, (kinds.get(t.rk) ?? 0) + 1));
  for (const [t, n] of kinds) tail.push({ k: "r", t, n });
  return [...out.slice(0, Math.max(0, EVIDENCE_REFS_MAX - tail.length)), ...tail].slice(0, EVIDENCE_REFS_MAX);
}

export interface ConversationTurnInput {
  conversationId: string;
  /** The stored, ALREADY-SCRUBBED question (one scrub for both sinks, S2 B3). */
  question: string;
  /**
   * Built by the route from FRESH guards, never from the request or the row: the conversation's OWN
   * area, and (P4b) every other area the operator holds now, each from its own guard (composed).
   */
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
  /** Platform AI memory (design v2): present ONLY when memory is effective. */
  memory?: MemoryTurn;
  /** Memory: proposal refusal codes (audited by the caller, no content). */
  onMemoryRefusals?(codes: readonly string[]): void;
  /** P2 — the turn boundary's invokeTool (the turn runner always passes it; absent ⇒ the executor). */
  invoke?: PlatformAiToolInvoker;
  /** P3 — the turn boundary's tool offer (router + more_tools); absent ⇒ every core tool. */
  tools?: PlatformAiTurnTools;
  /** P4 — the turn boundary's handle → record lookup (this turn's handles only). */
  records?: TurnRecordLookup;
  /** P4 — the turn boundary's replay re-authz (area recheck + revalidate ⇒ a handle of THIS turn). Absent ⇒ prior records replay as kind markers only. */
  remint?: RecordRemint;
  /**
   * P4b — the areas the operator holds NOW (the turn's fresh guards). A prior answer that read any
   * other area replays as "[no longer available]" and is never re-minted. Absent ⇒ pre-P4b (every answer replays).
   */
  heldAreas?: ReadonlySet<PlatformArea>;
}

export interface ConversationTurnRun {
  outcome: ConversationTurnOutcome;
  history: AssembledHistory | null;
  /** The provider transcript (tests only; the route never logs or stores it). */
  transcript: unknown[] | null;
  /** The v0 result (tests; the turn runner reads ONLY its metadata `trace` for the response's toolTrace — S2 09hu G1). */
  result: PlatformAiAnswer | null;
}

/** Run ONE conversation turn. Never throws: a provider failure, a timeout or an unstorable answer ⇒ FAILED with a code. */
export async function runConversationTurn(input: ConversationTurnInput): Promise<ConversationTurnRun> {
  let history: AssembledHistory | null = null;
  try {
    const reminted = await remintHistory(input.history, input.remint, input.heldAreas);
    history = assemblePlatformAiHistory({ conversationId: input.conversationId, messages: input.history, scope: historyScopeFor(input.binding, reminted, input.heldAreas) });
    const { result, transcript, record } = await runPlatformAiTurn({
      question: input.question, questionScrubbed: true, history,
      binding: input.binding, generate: input.generate, model: input.model, reasoningModel: input.reasoningModel,
      signal: input.signal ?? AbortSignal.timeout(PLATFORM_AI_TURN_TIMEOUT_MS),
      ...(input.memory ? { memory: input.memory.hooks } : {}),
      ...(input.invoke ? { invoke: input.invoke } : {}),
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.records ? { records: input.records } : {}),
    });
    if (result.grounding.replaced) input.onUngrounded?.(result.grounding.verdict, result.claims.unresolved);
    input.onTrace?.(`${traceLine(result)} history=${history.exchangesUsed}/${history.exchangesUsed + history.exchangesDropped}`);
    // S2 C1: a saved note the model echoed never reaches the stored transcript.
    const answer = input.memory ? input.memory.redactStored(storedAnswerOf(result, record)) : storedAnswerOf(result, record);
    // P4: an unstorable answer — a bad shape, or the identity rule (IDENTITY_LEAK, defence in depth) — is never stored.
    if (!isStoredAnswer(answer) || answerIdentityProblems(answer).length > 0) return { outcome: { status: "FAILED", failureCode: "PROVIDER" }, history, transcript, result };
    let memoryProposal: MemoryProposalCard | null = null;
    if (input.memory) {
      const fin = input.memory.finalize(segmentsText(result.answer));
      memoryProposal = fin.card;
      if (fin.refusals.length > 0) input.onMemoryRefusals?.(fin.refusals);
    }
    return { outcome: { status: "COMPLETE", answer, evidenceRefs: evidenceRefsOf(record), ...(input.memory ? { memoryProposal } : {}) }, history, transcript, result };
  } catch (err) {
    let code: "KILL_SWITCH" | "TIMEOUT" | "PROVIDER";
    try { code = input.classify(err); } catch { code = "PROVIDER"; }
    return { outcome: { status: "FAILED", failureCode: code }, history, transcript: null, result: null };
  }
}
