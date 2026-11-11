"use client";

/**
 * components/platform/PlatformAiAsk.tsx  (Platform AI v0 — a single session, shown ONLY when enabled)
 *
 * PLATFORM_AI_ENABLED on, conversations off: the SAME layout as Platform AI
 * conversations and Personal Space AI (owner 2026-11-08, Personal parity PR6) —
 * the shared `AiShell`, the starter headline and chips, the docked composer with
 * the short disclosure line ("… · Not saved · …" + a "Privacy" control that
 * expands the privacy text inline), and natural answers in the shared
 * answer frame with their sources collapsed beneath. One session in memory:
 * nothing is stored — no history, no draft persistence; leaving the page clears
 * it. Each question is its own POST /api/platform/ai/ask (the route re-applies
 * every gate); earlier turns are only shown, never sent back.
 *
 * ⚠️ OUTPUT SINK FOR MODEL TEXT. No Markdown parser runs on the answer: the
 * server already reduced it to plain-text segments plus links whose href is
 * exactly a resolver href of the turn (lib/platform/intelligence/ai/core.ts
 * sanitiseAnswer). The shared renderer (platform-ai-presentation) lays the text
 * out as paragraphs / lists (structure only), renders text as text (React
 * escapes it) and a link only when its href ALSO passes `isSameOriginPath` —
 * the AI Markdown renderer's own boundary (components/ai/Markdown.tsx, the
 * <img> exfil fix) — so even a compromised response body cannot load an image
 * or leave the site.
 *
 * Mobile: one reading column, min-w-0 everywhere and break-words, so nothing
 * overflows at 375 px.
 */

import { useRef, useState } from "react";
import { SquarePen } from "lucide-react";
import { AiShell } from "@/components/ai/AiShell";
import { AnswerFrame } from "@/components/ai/answer-frame";
import { ConversationLog, ThinkingIndicator } from "@/components/ai/ConversationView";
import { FailedTurn } from "@/components/ai/FailedTurn";
import { isSameOriginPath } from "@/components/ai/Markdown";
import { MessageCard } from "@/components/ai/MessageCard";
import { ToneBadge } from "@/components/platform/platform-surface";
import type { StatusTone } from "@/components/platform/widgets/job-health-format";
import type { AnswerSegment, PlatformAiAnswer } from "@/lib/platform/intelligence/ai/core";
import { PLATFORM_AI_TITLE } from "./PlatformAiPlaceholder";
import { AnswerNotes, AnswerSources, PlatformAiComposer, PlatformAiLead, PlatformAiStarters, TypedAnswerSegments } from "./platform-ai-presentation";
import { PLATFORM_AI_THINKING_LABEL } from "./platform-ai-conversations-model";
import { usePeoplePicker, type PeoplePickerBinding } from "./platform-ai-people-picker";

export const PLATFORM_AI_ASK_URL = "/api/platform/ai/ask";

const STATUS_TONE: Record<PlatformAiAnswer["citations"][number]["status"], StatusTone> = {
  MEASURED: "ok", ESTIMATED: "info", PARTIAL: "warn", UNAVAILABLE: "muted",
};
const STATUS_WORD: Record<PlatformAiAnswer["citations"][number]["status"], string> = {
  MEASURED: "Measured", ESTIMATED: "Estimated", PARTIAL: "Partial", UNAVAILABLE: "Unavailable",
};

const REFUSAL_COPY: Record<string, string> = {
  KILL_SWITCH: "AI requests are paused on this platform.",
  COST_FREEZE: "Platform costs are frozen, so AI is not running.",
  DAILY_TURNS: "You have used today's Platform AI questions. It resets at midnight UTC.",
  COST_CAP: "Platform AI has reached today's spending limit. It resets at midnight UTC.",
  ALLOWANCE_UNAVAILABLE: "Platform AI could not check its limits, so it did not run.",
  TIMEOUT: "That took too long, so it was stopped.",
  PROVIDER: "The AI provider did not answer.",
  NO_SURFACE: "Your access does not include Platform AI.",
};
const UNAVAILABLE = "Platform AI is unavailable right now.";

/** The v0 answer's segments through the shared typed renderer (corrections above; no Markdown). */
export function AnswerSegments({ segments }: { segments: readonly AnswerSegment[] }) {
  return <TypedAnswerSegments segments={segments} />;
}

/** Each cited metric: its status word, label, the server-rendered figure(s), the drill link, and the reason when unavailable / partial. */
export function AnswerCitations({ citations }: { citations: PlatformAiAnswer["citations"] }) {
  if (citations.length === 0) return null;
  return (
    <ul className="flex min-w-0 flex-col gap-2">
      {citations.map((c) => (
        <li key={c.metric} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <ToneBadge word={STATUS_WORD[c.status]} tone={STATUS_TONE[c.status]} />
          <span className="min-w-0 break-words font-medium text-[var(--text-primary)]">{c.label}</span>
          {(c.figures ?? []).length > 0
            ? <span data-platform-ai-figure="" className="min-w-0 break-words tabular-nums text-[var(--text-primary)]">{c.figures.join(" · ")}</span>
            : null}
          {c.href && isSameOriginPath(c.href)
            ? <a href={c.href} className="shrink-0 underline underline-offset-2 text-[var(--text-secondary)]">Open records</a>
            : null}
          {c.status === "UNAVAILABLE" || c.status === "PARTIAL"
            ? <span className="w-full min-w-0 break-words text-[var(--text-muted)]">{c.reason}</span>
            : null}
        </li>
      ))}
    </ul>
  );
}

/** One v0 answer in the shared answer frame; citations and notes collapsed beneath. */
export function SessionAnswer({ answer }: { answer: PlatformAiAnswer }) {
  const extras = answer.citations.length + answer.notes.length > 0 ? (
    <AnswerSources count={answer.citations.length}>
      <AnswerCitations citations={answer.citations} />
      <AnswerNotes notes={answer.notes} />
    </AnswerSources>
  ) : null;
  return (
    <section aria-label="Answer" className="min-w-0">
      <AnswerFrame extras={extras}><AnswerSegments segments={answer.answer} /></AnswerFrame>
    </section>
  );
}

/**
 * A turn of the in-memory session: the question, then its answer or its refusal sentence. `question` is what
 * was SENT (chips as `[[cust:…]]` tokens — the retry resends it); `display` is this operator's own view of it
 * (a chip as `@label`, memory only — never sent, never stored).
 */
export interface SessionTurn { id: number; question: string; display?: string; answer: PlatformAiAnswer | null; error: string | null }

export interface PlatformAiSessionViewProps {
  areaLabel: string;
  turns: readonly SessionTurn[];
  draft: string;
  pending: boolean;
  onDraft: (v: string) => void;
  onSend: () => void;
  onAsk: (question: string) => void;
  onNew: () => void;
  /** The "Privacy" control (collapsed by default: nothing is stored here). */
  noticeOpen?: boolean;
  onNotice?: (open: boolean) => void;
  /** P5 (S2 09dp) — the customers pack is offered: the customer-lookup notice (composer + empty state). */
  subjectNotice?: boolean;
  /** The @ people picker (offered with the customer notice). */
  picker?: PeoplePickerBinding;
  /** The server's USE_PEOPLE_PICKER refusal, inline under the kept draft. */
  guardNotice?: string | null;
}

/** Pure (no hooks except the log's anchor): the v0 page in the shared shell. */
export function PlatformAiSessionView({ areaLabel, turns, draft, pending, onDraft, onSend, onAsk, onNew, noticeOpen = false, onNotice, subjectNotice = false, picker, guardNotice = null }: PlatformAiSessionViewProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const mode = turns.length > 0 ? "conversation" : "empty";
  const last = turns[turns.length - 1];
  const answered = !pending && !!last && (last.answer !== null || last.error !== null);
  const controls = turns.length > 0 ? (
    <button type="button" data-platform-ai-new-chat="" onClick={onNew} disabled={pending}
      className="inline-flex items-center gap-1.5 h-8 rounded-lg px-2.5 text-xs font-medium transition-colors text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]">
      <SquarePen size={14} aria-hidden />
      <span className="max-sm:sr-only">New chat</span>
    </button>
  ) : null;
  return (
    <div data-platform-ai-session="" className="min-w-0">
      <AiShell
        mode={mode}
        title={PLATFORM_AI_TITLE}
        contextLabel={areaLabel}
        contextPrefix="Answering from: "
        controls={controls}
        lead={<PlatformAiLead subjectNotice={subjectNotice} />}
        aside={<PlatformAiStarters onStarter={onAsk} />}
        composer={<PlatformAiComposer value={draft} onChange={onDraft} onSubmit={onSend} busy={pending} disabled={false} saved={false} noticeOpen={noticeOpen} onNotice={onNotice} subjectNotice={subjectNotice} {...(picker ? { picker } : {})} guardNotice={guardNotice} />}
      >
        <ConversationLog scrollKey={turns} turnCount={turns.length} answered={answered} anchorRef={anchorRef}
          busy={pending} busyNode={<div data-platform-ai-in-flight=""><ThinkingIndicator srLabel={PLATFORM_AI_THINKING_LABEL} /></div>}>
          {turns.map((t, i) => (
            <div key={t.id} className="flex min-w-0 flex-col gap-7">
              <div ref={i === turns.length - 1 ? anchorRef : undefined} className="ai-turn-enter min-w-0"><MessageCard content={t.display ?? t.question} /></div>
              {t.answer ? <div className="ai-turn-enter min-w-0"><SessionAnswer answer={t.answer} /></div> : null}
              {t.error ? (
                <div className="ai-turn-enter min-w-0">
                  <FailedTurn message={t.error} busy={pending} announce={i === turns.length - 1}
                    onRetry={i === turns.length - 1 ? () => onAsk(t.question) : undefined} />
                </div>
              ) : null}
            </div>
          ))}
        </ConversationLog>
      </AiShell>
    </div>
  );
}

export function PlatformAiAsk({ areaLabel, subjectNotice = false }: { areaLabel: string; subjectNotice?: boolean }) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [guardNotice, setGuardNotice] = useState<string | null>(null);
  const nextId = useRef(0);
  // The @ people picker: offered exactly where the customer notice is (the page decides, server-side).
  const people = usePeoplePicker({ enabled: subjectNotice, draft, setDraft });

  async function ask(question: string, display?: string): Promise<boolean> {
    const q = question.trim();
    if (!q || pending) return false;
    const id = nextId.current++;
    setPending(true);
    setGuardNotice(null);
    setTurns((ts) => [...ts, { id, question: q, ...(display ? { display: display.trim() } : {}), answer: null, error: null }]);
    const settle = (answer: PlatformAiAnswer | null, error: string | null) =>
      setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, answer, error } : t)));
    try {
      const r = await fetch(PLATFORM_AI_ASK_URL, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }),
      });
      const body = await r.json().catch(() => null) as (PlatformAiAnswer & { reason?: string; error?: string }) | null;
      if (people.isGuardRefusal(body)) {
        // S2 09fc — not a turn: drop it, give the draft back (with its chips), and say why inline.
        setTurns((ts) => ts.filter((t) => t.id !== id));
        setDraft((d) => (d.length === 0 ? (display ?? q) : d));
        setGuardNotice(people.guardReminder(body));
        return true;
      }
      if (!r.ok || !body || !Array.isArray(body.answer)) {
        settle(null, (body?.reason && REFUSAL_COPY[body.reason]) ?? (r.status === 429 ? "Too many questions — try again shortly." : UNAVAILABLE));
      } else { settle(body, null); if (display !== undefined) people.reset(); }
    } catch {
      settle(null, UNAVAILABLE);
    } finally {
      setPending(false);
    }
    return true;
  }

  return (
    <PlatformAiSessionView
      areaLabel={areaLabel} turns={turns} draft={draft} pending={pending}
      onDraft={(v) => { setDraft(v); if (guardNotice) setGuardNotice(null); }}
      onSend={() => { if (draft.trim() && !pending) { void ask(people.serialize(), draft); setDraft(""); } }}
      onAsk={(q) => { void ask(q); }}
      onNew={() => { if (!pending) { setTurns([]); setDraft(""); setGuardNotice(null); people.reset(); } }}
      noticeOpen={noticeOpen} onNotice={setNoticeOpen} subjectNotice={subjectNotice}
      picker={people.binding} guardNotice={guardNotice}
    />
  );
}
