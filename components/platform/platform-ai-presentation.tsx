"use client";

/**
 * components/platform/platform-ai-presentation.tsx  (Platform AI — Personal Space AI parity, PR6)
 *
 * The presentation BOTH Platform AI surfaces share — conversations
 * (PlatformAiConversations) and the single-session v0 (PlatformAiAsk) — so the
 * two look like Personal Space AI and like each other: the starter lead and
 * chips, the docked composer with ONE disclosure line, and the answer body.
 * Props-driven, no fetch, no storage.
 *
 * ⚠️ OUTPUT SINK FOR MODEL TEXT. No Markdown parser: an answer is the typed
 * segment list the server produced (core.ts sanitiseAnswer; stored §2.5), laid
 * out by `answerBlocks` into paragraphs / simple lists (structure only) and
 * rendered as React text. A link renders only for a server `link` segment whose
 * href ALSO passes `isSameOriginPath` (the AI Markdown renderer's boundary).
 */

import type { ReactNode } from "react";
import { ArrowUp, Info } from "lucide-react";
import { ComposerFrame } from "@/components/ai/Composer";
import { isSameOriginPath } from "@/components/ai/Markdown";
import { StarterLine } from "@/components/ai/StarterLine";
import { SuggestedPrompt } from "@/components/ai/SuggestedPrompt";
import {
  PLATFORM_AI_COMPOSER_MAX, PLATFORM_AI_CONVERSATIONS_DISCLOSURE, PLATFORM_AI_CONVERSATIONS_LINE, PLATFORM_AI_PRIVACY_HINT,
  PLATFORM_AI_SESSION_LINE, PLATFORM_AI_SESSION_NOT_SAVED, PLATFORM_AI_STARTER_HEADLINE, PLATFORM_AI_STARTER_PROMPTS,
  answerBlocks, showComposerCounter, type ClientSegment, type InlineSegment,
} from "./platform-ai-conversations-model";
import { PLATFORM_AI_MEMORY_LINE } from "./platform-ai-memory-model";
import { PLATFORM_AI_SUBJECT_NOTICE } from "@/lib/platform/intelligence/ai/authz/subject-notice";

// ── The answer body ─────────────────────────────────────────────────────────

/**
 * S2 F-C1 (ii) / #460: the server's period CORRECTION segments (code-written,
 * never model text) — their own callout ABOVE the answer, never inline in the
 * prose, and visually distinct from it: a bordered, tinted callout with an
 * accent rule (Personal's note idiom, not the old orange warning box), primary
 * text, role="note" with its own accessible name. Each correction is rendered
 * whole (never split); model text never enters this block.
 */
export function PeriodCorrections({ segments }: { segments: readonly { kind: string; text: string }[] }) {
  const corrections = segments.filter((s) => s.kind === "correction");
  if (corrections.length === 0) return null;
  return (
    <div role="note" aria-label="Correction" data-platform-ai-correction=""
      className="mb-3 flex min-w-0 gap-2 rounded-lg border border-[var(--border-hairline-strong)] border-l-[3px] border-l-[var(--accent-info)] bg-[var(--surface-inset)] px-3 py-2 text-sm font-medium leading-relaxed text-[var(--text-primary)]">
      <Info size={15} aria-hidden className="mt-[3px] shrink-0 text-[var(--accent-info)]" />
      <div className="min-w-0">
        {corrections.map((c, i) => <p key={i} className="min-w-0 break-words">{c.text}</p>)}
      </div>
    </div>
  );
}

/**
 * F-1 (S2, 2026-11-08): the server's WINDOW NOTE segments ("Note: You asked about <asked>;
 * <metric> covers <served window> instead." — G1b-1) — code-written, never model text. Their own
 * QUIET note above the answer (role="note", aria-label "Note"): a hairline callout in
 * secondary text, quieter than the correction, never inline in the prose.
 */
export function WindowNotes({ segments }: { segments: readonly { kind: string; text: string }[] }) {
  const notes = segments.filter((s) => s.kind === "note");
  if (notes.length === 0) return null;
  return (
    <div role="note" aria-label="Note" data-platform-ai-window-note=""
      className="mb-3 flex min-w-0 gap-2 rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-inset)] px-3 py-2 text-sm leading-relaxed text-[var(--text-secondary)]">
      <Info size={15} aria-hidden className="mt-[3px] shrink-0 text-[var(--text-muted)]" />
      <div className="min-w-0">
        {notes.map((c, i) => <p key={i} className="min-w-0 break-words">{c.text}</p>)}
      </div>
    </div>
  );
}

/** A stale chip: the relative time, the UTC stamp as its title. */
export interface ChipText { chip: string; title: string }

function Inline({ s, chips }: { s: InlineSegment; chips?: ReadonlyMap<number, ChipText> }) {
  if (s.kind === "link") {
    return isSameOriginPath(s.href)
      ? <a href={s.href} className="underline underline-offset-2">{s.text}</a>
      : <span>{s.text}</span>;
  }
  if (s.kind === "memory") {
    return <span data-platform-ai-memory="" className="italic text-[var(--text-secondary)]">{s.text}</span>;
  }
  if (s.kind === "figure") {
    const chip = chips?.get(s.seg);
    return (
      <span>
        <span data-platform-ai-figure="" className="tabular-nums font-medium text-[var(--text-primary)]">{s.text}</span>
        {chip ? (
          <span data-platform-ai-stale-chip="figure" title={chip.title}
            className="ml-1 inline-flex items-center rounded-full border border-[var(--border-hairline)] px-1.5 align-middle text-[10px] font-normal leading-4 text-[var(--text-secondary)]">
            {chip.chip}
          </span>
        ) : null}
      </span>
    );
  }
  return <span>{s.text}</span>;
}

function Line({ line, chips }: { line: readonly InlineSegment[]; chips?: ReadonlyMap<number, ChipText> }) {
  return <>{line.map((s, i) => <Inline key={i} s={s} chips={chips} />)}</>;
}

/**
 * A typed answer: the correction callout, then paragraphs / lists of text, figures
 * and same-origin links. `chips`: per-figure "as of" chips by segment index.
 */
export function TypedAnswerSegments({ segments, chips }: { segments: readonly ClientSegment[]; chips?: ReadonlyMap<number, ChipText> }) {
  const blocks = answerBlocks(segments);
  return (
    <>
      <PeriodCorrections segments={segments} />
      <WindowNotes segments={segments} />
      <div data-platform-ai-body="" className="min-w-0 space-y-3 break-words leading-relaxed text-[var(--text-primary)]">
        {blocks.map((b, i) => {
          if (b.kind === "p") {
            return (
              <p key={i} className="min-w-0">
                {b.lines.map((l, j) => <span key={j}>{j > 0 ? <br /> : null}<Line line={l} chips={chips} /></span>)}
              </p>
            );
          }
          if (b.kind === "label") {
            return <p key={i} data-platform-ai-section="" className="min-w-0 text-sm font-semibold text-[var(--text-primary)]"><Line line={b.line} chips={chips} /></p>;
          }
          const List = b.kind === "ul" ? "ul" : "ol";
          return (
            <List key={i} className={`min-w-0 space-y-1 pl-5 ${b.kind === "ul" ? "list-disc" : "list-decimal"}`}>
              {b.items.map((item, j) => {
                const sub = b.sub?.[j] ?? null;
                const SubList = sub?.kind === "ol" ? "ol" : "ul";
                return (
                  <li key={j} className="min-w-0"><Line line={item} chips={chips} />{sub ? (
                    <SubList data-platform-ai-nested="" className={`mt-1 min-w-0 space-y-1 pl-5 ${sub.kind === "ul" ? "list-[circle]" : "list-decimal"}`}>
                      {sub.items.map((x, k) => <li key={k} className="min-w-0"><Line line={x} chips={chips} /></li>)}
                    </SubList>
                  ) : null}</li>
                );
              })}
            </List>
          );
        })}
      </div>
    </>
  );
}

/** Sources and notes, collapsed by default beneath an answer (a native <details>: no state, no script). */
export function AnswerSources({ count, children }: { count: number; children: ReactNode }) {
  return (
    <details data-platform-ai-sources="" className="group min-w-0 text-xs text-[var(--text-secondary)]">
      <summary className="inline-flex min-h-7 cursor-pointer select-none items-center gap-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]">
        {count > 0 ? `Sources (${count})` : "Notes"}
      </summary>
      <div className="mt-2 flex min-w-0 flex-col gap-2 border-l border-[var(--border-hairline)] pl-3">{children}</div>
    </details>
  );
}

/** Deterministic notes (code-written) inside the Sources disclosure. */
export function AnswerNotes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="flex min-w-0 flex-col gap-1">
      {notes.map((n, i) => <li key={i} className="min-w-0 break-words">{n}</li>)}
    </ul>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────────

/**
 * P5 (S2 09dp) — the customer-lookup notice: exact ID or email only, never a name. Shown ONLY where
 * the customers pack is offered (the page decides: lib/platform/intelligence/ai/authz/subject-notice.ts).
 */
export function PlatformAiSubjectNotice({ where }: { where: "lead" | "composer" }) {
  return (
    <p data-platform-ai-subject-notice={where} className="min-w-0 break-words text-center text-xs text-[var(--text-secondary)]">
      {PLATFORM_AI_SUBJECT_NOTICE}
    </p>
  );
}

/** The headline, at Personal's size (the shared StarterLine with a fixed headline: it never rotates). */
export function PlatformAiLead({ subjectNotice = false }: { subjectNotice?: boolean } = {}) {
  return (
    <div data-platform-ai-empty="" className="min-w-0">
      <StarterLine initialIndex={0} frozen headline={PLATFORM_AI_STARTER_HEADLINE} />
      {subjectNotice ? <div className="mt-3"><PlatformAiSubjectNotice where="lead" /></div> : null}
    </div>
  );
}

/** The starter chips: short labels; each asks its full prompt. pb-8 = the dock's fade (AiShell h-8). */
export function PlatformAiStarters({ onStarter }: { onStarter: (prompt: string) => void }) {
  return (
    <div data-platform-ai-starters="" role="group" aria-label="Suggestions" className="mx-auto flex w-full min-w-0 max-w-3xl flex-wrap justify-center gap-2 pb-8">
      {PLATFORM_AI_STARTER_PROMPTS.map((s) => <SuggestedPrompt key={s.label} label={s.label} onSelect={() => onStarter(s.prompt)} />)}
    </div>
  );
}

// ── The composer and its one disclosure line ────────────────────────────────

/** The full-text element ids: the composer's aria-describedby targets, ALWAYS in the DOM (S2 C4). */
export const PLATFORM_AI_DISCLOSURE_ID = "platform-ai-conversations-disclosure";
export const PLATFORM_AI_PRIVACY_HINT_ID = "platform-ai-privacy-hint";
/** The expandable region (aria-controls of the "Privacy & retention" control). */
export const PLATFORM_AI_NOTICE_REGION_ID = "platform-ai-notice";

/**
 * The FULL notice region (S2 C2/C4): the owner-approved OD-5 text (conversations)
 * or the not-saved sentence (v0), and the v0 privacy hint, unchanged. Rendered
 * exactly once on the page and always in the DOM; collapsed ⇒ `hidden` (still a
 * valid describedby target). Never in a scroll box of its own.
 */
export function PlatformAiNotice({ open, saved }: { open: boolean; saved: boolean }) {
  return (
    <div id={PLATFORM_AI_NOTICE_REGION_ID} data-platform-ai-notice={open ? "open" : "closed"} hidden={!open}
      className="min-w-0 space-y-1.5 text-left text-xs leading-relaxed text-[var(--text-secondary)]">
      {saved ? (
        <p id={PLATFORM_AI_DISCLOSURE_ID} data-platform-ai-conversations-disclosure="" className="min-w-0 break-words">{PLATFORM_AI_CONVERSATIONS_DISCLOSURE}</p>
      ) : (
        <p data-platform-ai-session-notice="" className="min-w-0 break-words">{PLATFORM_AI_SESSION_NOT_SAVED}</p>
      )}
      <p id={PLATFORM_AI_PRIVACY_HINT_ID} data-platform-ai-privacy-hint="" className="min-w-0 break-words">{PLATFORM_AI_PRIVACY_HINT}</p>
    </div>
  );
}

/**
 * The short line + its control (S2 C1/C2): the line is always visible and wraps
 * (never truncated); "Privacy & retention" is a real button with aria-expanded /
 * aria-controls that expands the full notice INLINE (no modal, no scroll box);
 * focus stays on the button.
 */
export function PlatformAiDisclosureLine({ saved, open, onToggle, memory = false }: { saved: boolean; open: boolean; onToggle: (open: boolean) => void; memory?: boolean }) {
  // S2 MEMORY BUILD CHECKLIST: with memory effective "Read-only" is false (Remember writes a row) ⇒ the memory line.
  const line = !saved ? PLATFORM_AI_SESSION_LINE : memory ? PLATFORM_AI_MEMORY_LINE : PLATFORM_AI_CONVERSATIONS_LINE;
  return (
    <p data-platform-ai-disclosure={saved ? (memory ? "memory" : "conversations") : "session"} className="min-w-0 break-words text-center leading-5">
      <span data-platform-ai-line="">{line}</span>
      <span aria-hidden> · </span>
      <button type="button" data-platform-ai-notice-toggle="" aria-expanded={open} aria-controls={PLATFORM_AI_NOTICE_REGION_ID}
        onClick={() => onToggle(!open)}
        className="inline-flex min-h-7 items-center rounded px-0.5 font-medium text-[var(--text-primary)] underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]">
        {saved ? "Privacy & retention" : "Privacy"}
      </button>
    </p>
  );
}

/** While a send is in flight the send button shows, disabled. There is NO Stop (S2: an abort would not cancel the server turn). */
const BUSY_SEND_CLASS = "w-11 h-11 rounded-full flex items-center justify-center shrink-0 text-white bg-[var(--accent-info)] opacity-35 cursor-not-allowed";

export interface PlatformAiComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  busy: boolean;
  /** Conversations (saved, the OD-5 notice) or v0 (a single session, nothing saved). */
  saved?: boolean;
  /** Whether the full notice is expanded. */
  noticeOpen?: boolean;
  onNotice?: (open: boolean) => void;
  /**
   * Where the full notice region lives: here, under the line (default), or —
   * "lead" — at the top of the empty state's reading region (the view renders it
   * there, so a first visit's expanded notice is never clipped by the dock).
   */
  noticeIn?: "footer" | "lead";
  /** Platform AI memory is effective (the page decides, server-side): the corrected short line. */
  memory?: boolean;
  /** P5 (S2 09dp) — the customers pack is offered (the page decides, server-side): the customer-lookup notice. */
  subjectNotice?: boolean;
}

/**
 * The Platform composer: the shared `ComposerFrame` (docked pill, integrated
 * send, auto-grow, Enter-to-send, IME-safe) bound to v0's box contract — the
 * `platform-ai-question` id and 500 characters — with the short disclosure line
 * beneath. The counter appears only near the limit. aria-describedby points at
 * the full-text elements (S2 C4).
 */
export function PlatformAiComposer({ value, onChange, onSubmit, disabled, busy, saved = true, noticeOpen = false, onNotice, noticeIn = "footer", memory = false, subjectNotice = false }: PlatformAiComposerProps) {
  return (
    <ComposerFrame
      value={value}
      onChange={onChange}
      onSubmit={onSubmit}
      label="Ask Platform AI"
      inputId="platform-ai-question"
      maxLength={PLATFORM_AI_COMPOSER_MAX}
      placeholder="Ask about the platform…"
      describedBy={saved ? `${PLATFORM_AI_PRIVACY_HINT_ID} ${PLATFORM_AI_DISCLOSURE_ID}` : PLATFORM_AI_PRIVACY_HINT_ID}
      disabled={disabled}
      trailing={busy && !disabled ? (
        <button type="submit" disabled aria-label="Send message" aria-busy="true" className={BUSY_SEND_CLASS}>
          <ArrowUp size={17} strokeWidth={2.25} />
        </button>
      ) : undefined}
      footer={
        <div data-platform-ai-composer-footer="" className="mt-2 flex min-w-0 flex-col items-center gap-1.5 px-1 text-[11px] text-[var(--text-secondary)]">
          {subjectNotice ? <PlatformAiSubjectNotice where="composer" /> : null}
          <PlatformAiDisclosureLine saved={saved} open={noticeOpen} onToggle={(v) => onNotice?.(v)} memory={memory} />
          {noticeIn === "footer" ? <PlatformAiNotice open={noticeOpen} saved={saved} /> : null}
          {showComposerCounter(value.length) ? (
            <span data-platform-ai-counter="" className="tabular-nums">{value.length}/{PLATFORM_AI_COMPOSER_MAX}</span>
          ) : null}
        </div>
      }
    />
  );
}
