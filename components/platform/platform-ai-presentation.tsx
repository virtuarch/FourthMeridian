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
import { AiDisclosure } from "@/components/ai/AiDisclosure";
import { ComposerFrame } from "@/components/ai/Composer";
import { isSameOriginPath } from "@/components/ai/Markdown";
import { StarterLine } from "@/components/ai/StarterLine";
import { SuggestedPrompt } from "@/components/ai/SuggestedPrompt";
import {
  PLATFORM_AI_COMPOSER_MAX, PLATFORM_AI_CONVERSATIONS_DISCLOSURE, PLATFORM_AI_CONVERSATIONS_LINE, PLATFORM_AI_PRIVACY_HINT,
  PLATFORM_AI_SESSION_LINE, PLATFORM_AI_SESSION_NOT_SAVED, PLATFORM_AI_STARTER_HEADLINE, PLATFORM_AI_STARTER_PROMPTS,
  answerBlocks, showComposerCounter, type ClientSegment, type InlineSegment,
} from "./platform-ai-conversations-model";

// ── The answer body ─────────────────────────────────────────────────────────

/**
 * S2 F-C1 (ii): the server's period CORRECTION segments (code-written, never
 * model text) — their own note ABOVE the answer, never inline in the prose.
 * Owner 2026-11-08: a quiet note (info glyph, secondary text), not a warning box.
 */
export function PeriodCorrections({ segments }: { segments: readonly { kind: string; text: string }[] }) {
  const corrections = segments.filter((s) => s.kind === "correction");
  if (corrections.length === 0) return null;
  return (
    <div role="note" data-platform-ai-correction="" className="mb-2 flex min-w-0 gap-1.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
      <Info size={14} aria-hidden className="mt-[3px] shrink-0 text-[var(--text-muted)]" />
      <div className="min-w-0">
        {corrections.map((c, i) => <p key={i} className="min-w-0 break-words">{c.text}</p>)}
      </div>
    </div>
  );
}

function Inline({ s }: { s: InlineSegment }) {
  if (s.kind === "link") {
    return isSameOriginPath(s.href)
      ? <a href={s.href} className="underline underline-offset-2">{s.text}</a>
      : <span>{s.text}</span>;
  }
  if (s.kind === "figure") return <span data-platform-ai-figure="" className="tabular-nums font-medium text-[var(--text-primary)]">{s.text}</span>;
  return <span>{s.text}</span>;
}

function Line({ line }: { line: readonly InlineSegment[] }) {
  return <>{line.map((s, i) => <Inline key={i} s={s} />)}</>;
}

/** A typed answer: the correction note, then paragraphs / lists of text, figures and same-origin links. */
export function TypedAnswerSegments({ segments }: { segments: readonly ClientSegment[] }) {
  const blocks = answerBlocks(segments);
  return (
    <>
      <PeriodCorrections segments={segments} />
      <div data-platform-ai-body="" className="min-w-0 space-y-3 break-words leading-relaxed text-[var(--text-primary)]">
        {blocks.map((b, i) => {
          if (b.kind === "p") {
            return (
              <p key={i} className="min-w-0">
                {b.lines.map((l, j) => <span key={j}>{j > 0 ? <br /> : null}<Line line={l} /></span>)}
              </p>
            );
          }
          const List = b.kind === "ul" ? "ul" : "ol";
          return (
            <List key={i} className={`min-w-0 space-y-1 pl-5 ${b.kind === "ul" ? "list-disc" : "list-decimal"}`}>
              {b.items.map((item, j) => <li key={j} className="min-w-0"><Line line={item} /></li>)}
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

/** The headline, at Personal's size (the shared StarterLine with a fixed headline: it never rotates). */
export function PlatformAiLead() {
  return (
    <div data-platform-ai-empty="" className="min-w-0">
      <StarterLine initialIndex={0} frozen headline={PLATFORM_AI_STARTER_HEADLINE} />
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

/** The OD-5 notice's id: the composer's aria-describedby target (always in the DOM). */
export const PLATFORM_AI_DISCLOSURE_ID = "platform-ai-conversations-disclosure";
export const PLATFORM_AI_PRIVACY_HINT_ID = "platform-ai-privacy-hint";

/**
 * ONE visible line ("Read-only · Chats hidden after N days · Don't enter personal
 * details · About"), Personal's AiDisclosure. The full owner-approved OD-5 text
 * and the v0 privacy hint stay in the DOM as the composer's aria-describedby
 * targets (screen-reader only) and are shown in full in the About panel.
 */
export function PlatformAiDisclosure({ saved }: { saved: boolean }) {
  return (
    <div data-platform-ai-disclosure={saved ? "conversations" : "session"} className="min-w-0">
      <p id={PLATFORM_AI_PRIVACY_HINT_ID} data-platform-ai-privacy-hint="" className="sr-only">{PLATFORM_AI_PRIVACY_HINT}</p>
      {saved ? (
        <p id={PLATFORM_AI_DISCLOSURE_ID} data-platform-ai-conversations-disclosure="" className="sr-only">{PLATFORM_AI_CONVERSATIONS_DISCLOSURE}</p>
      ) : null}
      <AiDisclosure line={saved ? PLATFORM_AI_CONVERSATIONS_LINE : PLATFORM_AI_SESSION_LINE} title="About Platform AI">
        <p>{PLATFORM_AI_PRIVACY_HINT}</p>
        <p data-platform-ai-notice-full="">{saved ? PLATFORM_AI_CONVERSATIONS_DISCLOSURE : PLATFORM_AI_SESSION_NOT_SAVED}</p>
        <p>Answers use only the Platform figures you can already see.</p>
      </AiDisclosure>
    </div>
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
}

/**
 * The Platform composer: the shared `ComposerFrame` (docked pill, integrated
 * send, auto-grow, Enter-to-send, IME-safe) bound to v0's box contract — the
 * `platform-ai-question` id and 500 characters — with the one disclosure line
 * beneath. The counter appears only near the limit.
 */
export function PlatformAiComposer({ value, onChange, onSubmit, disabled, busy, saved = true }: PlatformAiComposerProps) {
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
        <div data-platform-ai-composer-footer="" className="mt-2 flex min-w-0 flex-col items-center px-1 text-[11px] text-[var(--text-secondary)]">
          <PlatformAiDisclosure saved={saved} />
          {showComposerCounter(value.length) ? (
            <span data-platform-ai-counter="" className="tabular-nums">{value.length}/{PLATFORM_AI_COMPOSER_MAX}</span>
          ) : null}
        </div>
      }
    />
  );
}
