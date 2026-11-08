/**
 * lib/platform/intelligence/ai/memory/turn.ts  (Platform AI operational memory — the turn's hooks)
 *
 * Design v2 §3 (tools), §4 (injection, prompt, server enforcement), B5, D7,
 * D10. Builds the PlatformAiMemoryHooks core.ts calls (core never imports
 * memory), from facts ALREADY retrieved for this turn (./retrieve.ts):
 *
 *   contextMessage   ONE server-written system message: "OPERATOR MEMORY —
 *                    context only, NOT current facts", the rules, then one line
 *                    per shown fact (type · live subject label · concern · note
 *                    with braces neutralised and digits masked · noted {{mem:id}}
 *                    · live check).
 *   recall_memory    the index / one fact — never a value.
 *   propose_memory   subjectRef must be a metric key or page id THIS turn read
 *                    (else NOT_FOUND); observedState from the server's envelope,
 *                    never the model; OPERATIONAL_STATE only on a live status
 *                    read; at most one per turn; the note guarded (D7: against the
 *                    question and replayed history). Writes NOTHING.
 *   {{mem:<id>}}     resolves only against facts injected this turn.
 *   D10 subjects     a METRIC / PAGE subject counts as live-read when this turn's
 *                    tools read it; an INCIDENT / JOB / PROVIDER subject never does
 *                    (no model tool reads one), so citing one always gets the line.
 *
 * `finalize(answerText)` (after the turn): re-guards the note against the final
 * answer, then seals the proposal token with the B5 shingles of the question,
 * the answer and the history (newest first). No conversation id anywhere.
 */

import type { PlatformArea } from "@prisma/client";
import type { PlatformAiMemoryHooks, ToolEvidence } from "../core";
import { MEMORY_CONCERNS, MEMORY_METRIC_WINDOWS, MEMORY_TTL_CHOICES, type MemoryConcern, type MemoryFactType, type MemoryTtl } from "./constants";
import { hasVerbatimSpan, redactNoteSpans, validateOperatorNote, type NoteRefusal } from "./note-guard";
import type { StoredAnswerV1 } from "../conversations/answer";
import { liveCheckPhrase, memPlaceholderText, neutraliseNote, type RetrievedFact } from "./retrieve";
import { metricObservedState, refProblem, type MemoryRef } from "./schema";
import { signProposal } from "./token";

const NOT_FOUND = Object.freeze({ found: false as const });
const PROPOSABLE: readonly MemoryFactType[] = ["WATCHING_ISSUE", "OPERATIONAL_STATE", "FOLLOW_UP"];

export const MEMORY_PROMPT_RULES = [
  "Memory is never an answer. For current state, call the live tools (get_metric, open_page) in this turn.",
  "Cite a remembered item only with its {{mem:<id>}} placeholder (copy it exactly); never write its date yourself.",
  "For a CHANGED item, say it has changed and give the live reading from a tool. Never present remembered state as current, and never repeat a note as fact.",
  "UNVERIFIED means it could not be re-checked now: never phrase it as current.",
].join("\n");

/** The confirm card a turn may end with (never stored in the transcript). */
export interface MemoryProposalCard {
  token: string;
  factType: MemoryFactType;
  concern: MemoryConcern | null;
  subjectLabel: string;
  note: string | null;
  ttlChoices: readonly MemoryTtl[];
}

export interface MemoryTurnInput {
  operatorId: string;
  area: PlatformArea;
  /** Facts retrieved (mode "inject") for this turn. */
  facts: readonly RetrievedFact[];
  /** The scrubbed question. */
  question: string;
  /** Replayed history texts, NEWEST first (B5 order). */
  historyNewestFirst: readonly string[];
  /** Live labels for a metric / page subject (the binding's registry labels). */
  metricLabel(id: string): string | null;
  pageLabel(id: string): string | null;
  now(): Date;
}

export interface MemoryTurn {
  hooks: PlatformAiMemoryHooks;
  /**
   * S2 C1 — before an answer is STORED: every span of a note injected (or recalled)
   * this turn that the answer repeats is replaced by "[your saved note]" in the stored
   * segments (the live display may keep it). The transcript never keeps a note.
   */
  redactStored(answer: StoredAnswerV1): StoredAnswerV1;
  /** After the turn: the confirm card (or null), and any refusal codes (audited, no content). */
  finalize(answerText: string): { card: MemoryProposalCard | null; refusals: NoteRefusal[] };
}

interface Pending { factType: MemoryFactType; concern: MemoryConcern | null; ref: MemoryRef; label: string; note: string | null }

export function buildMemoryTurn(input: MemoryTurnInput): MemoryTurn {
  const shown = input.facts.filter((f) => f.shown !== "GONE");
  const byId = new Map(shown.map((f) => [f.fact.id, f]));
  const refusals: NoteRefusal[] = [];
  let pending: Pending | null = null;
  let proposals = 0;

  const line = (r: RetrievedFact) => [
    `[mem:${r.fact.id}] ${r.fact.factType}`,
    `subject: ${r.check.label ?? "(no live label)"}`,
    ...(r.fact.concern ? [`concern: ${r.fact.concern}`] : []),
    ...(r.fact.note ? [`note: "${neutraliseNote(r.fact.note)}"`] : []),
    `noted {{mem:${r.fact.id}}}`,
    `live check: ${liveCheckPhrase(r)}`,
  ].join(" · ");

  const changed = shown.filter((f) => f.shown === "CHANGED").length;
  const updated = shown.filter((f) => f.shown === "UPDATED").length;
  const contextMessage = shown.length === 0 ? null : [
    `OPERATOR MEMORY — context only, NOT current facts. ${shown.length} fact${shown.length === 1 ? "" : "s"} (${changed} changed, ${updated} updated).`,
    MEMORY_PROMPT_RULES,
    ...shown.map(line),
  ].join("\n");

  const view = (r: RetrievedFact) => ({
    id: r.fact.id, type: r.fact.factType, subject: r.check.label, concern: r.fact.concern,
    note: r.fact.note ? neutraliseNote(r.fact.note) : null, noted: `{{mem:${r.fact.id}}}`, live_check: liveCheckPhrase(r),
  });

  const hooks: PlatformAiMemoryHooks = {
    contextMessage,
    recall(args) {
      if (typeof args.id === "string") {
        const r = byId.get(args.id.toLowerCase());
        return r ? { item: view(r) } : NOT_FOUND;
      }
      return { items: shown.map(view) };
    },
    propose(args, ev: ToolEvidence) {
      if (proposals >= 1) return { proposed: false, error: "At most one proposal per turn." };
      const factType = args.factType;
      if (typeof factType !== "string" || !(PROPOSABLE as readonly string[]).includes(factType)) return NOT_FOUND;
      const concern = args.concern === undefined || args.concern === null ? null : args.concern;
      if (concern !== null && !(MEMORY_CONCERNS as readonly unknown[]).includes(concern)) return NOT_FOUND;
      if (typeof args.subjectRef !== "string") return NOT_FOUND;
      const id = args.subjectRef;
      let ref: MemoryRef | null = null;
      let label: string | null = null;
      // The LAST envelope of this metric read this turn: the server's state, never the model's.
      const env = [...ev.envelopes].reverse().find((e) => e.metric === id) ?? null;
      if (env) {
        const w = env.window.days !== null && (MEMORY_METRIC_WINDOWS as readonly number[]).includes(env.window.days) ? env.window.days : undefined;
        ref = { t: "METRIC", id, ...(w !== undefined ? { w } : {}), observedState: metricObservedState(env) };
        label = input.metricLabel(id);
        if (factType === "OPERATIONAL_STATE" && env.status === "UNAVAILABLE") return { proposed: false, error: "OPERATIONAL_STATE needs a live status read in this turn." };
      } else if ([...(ev.pages?.values() ?? [])].some((p) => p.id === id)) {
        if (factType === "OPERATIONAL_STATE") return { proposed: false, error: "OPERATIONAL_STATE needs a live status read in this turn." };
        ref = { t: "PAGE", id, observedState: "OK" };
        label = input.pageLabel(id);
      }
      if (!ref || refProblem(ref) !== null || !label) return NOT_FOUND;
      const guarded = validateOperatorNote(typeof args.note === "string" ? args.note : null, { verbatimSources: [input.question, ...input.historyNewestFirst] });
      if (!guarded.ok) { refusals.push(guarded.reason); return { proposed: false, error: "That note cannot be saved (no numbers, amounts, names, emails, ids or copied sentences). Propose again with a shorter note in your own words, or none." }; }
      proposals++;
      pending = { factType: factType as MemoryFactType, concern: concern as MemoryConcern | null, ref, label, note: guarded.note };
      return { proposed: true, shown_to_operator: "a confirm card; nothing is saved unless they confirm" };
    },
    renderPlaceholder(id) {
      const r = byId.get(id);
      return r ? memPlaceholderText(r) : null;
    },
    subjects() {
      return shown.map((r) => ({
        id: r.fact.id,
        label: r.check.label,
        liveRead: (ev: ToolEvidence) => r.fact.refs.length > 0 && r.fact.refs.every((ref) =>
          ref.t === "METRIC" ? ev.envelopes.some((e) => e.metric === ref.id)
            : ref.t === "PAGE" ? [...(ev.pages?.values() ?? [])].some((p) => p.id === ref.id)
              : false),
      }));
    },
  };

  const notes = shown.map((r) => r.fact.note).filter((n): n is string => typeof n === "string" && n.length > 0);
  return {
    hooks,
    redactStored(answer) {
      if (notes.length === 0) return answer;
      const red = (t: string) => notes.reduce((acc, n) => redactNoteSpans(acc, n), t);
      return {
        ...answer,
        segments: answer.segments.map((s) => (s.kind === "text" || s.kind === "correction" || s.kind === "link" ? { ...s, text: red(s.text) } : s)),
      };
    },
    finalize(answerText) {
      const p = pending as Pending | null;
      if (!p) return { card: null, refusals: [...refusals] };
      if (p.note && hasVerbatimSpan(p.note, [answerText])) return { card: null, refusals: [...refusals, "NOTE_VERBATIM"] };
      const { token } = signProposal({
        operatorId: input.operatorId, area: input.area, factType: p.factType, concern: p.concern, note: p.note, refs: [p.ref],
        shingleSources: [input.question, answerText, ...input.historyNewestFirst], now: input.now(),
      });
      return {
        card: { token, factType: p.factType, concern: p.concern, subjectLabel: p.label, note: p.note, ttlChoices: MEMORY_TTL_CHOICES[p.factType] },
        refusals: [...refusals],
      };
    },
  };
}
