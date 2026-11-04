"use client";

/**
 * components/platform/PlatformAiAsk.tsx  (Platform AI v0 — the question box, shown ONLY when enabled)
 *
 * A minimal question box and one answer: the answer's segments, each cited
 * metric with its status chip and drill link, and the deterministic notes.
 * Nothing is stored — no history, no draft persistence.
 *
 * ⚠️ OUTPUT SINK FOR MODEL TEXT. No Markdown parser runs on the answer: the
 * server already reduced it to plain-text segments plus links whose href is
 * exactly a resolver href of the turn (lib/platform/intelligence/ai/core.ts
 * sanitiseAnswer). This component renders text as text (React escapes it) and a
 * link only when its href ALSO passes `isSameOriginPath` — the AI Markdown
 * renderer's own boundary (components/ai/Markdown.tsx, the <img> exfil fix) —
 * so even a compromised response body cannot load an image or leave the site.
 *
 * Mobile: one reading column, min-w-0 everywhere and break-words, so nothing
 * overflows at 375 px.
 */

import { useState } from "react";
import { AiMark } from "@/components/ai/AiMark";
import { isSameOriginPath } from "@/components/ai/Markdown";
import { ToneBadge } from "@/components/platform/platform-surface";
import type { StatusTone } from "@/components/platform/widgets/job-health-format";
import type { AnswerSegment, PlatformAiAnswer } from "@/lib/platform/intelligence/ai/core";
import { PLATFORM_AI_TITLE } from "./PlatformAiPlaceholder";

export const PLATFORM_AI_ASK_URL = "/api/platform/ai/ask";
const MAX = 500;

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
  ALLOWANCE_UNAVAILABLE: "Platform AI could not check its limits, so it did not run.",
  TIMEOUT: "That took too long, so it was stopped.",
  PROVIDER: "The AI provider did not answer.",
  NO_SURFACE: "Your access does not include Platform AI.",
};

export function AnswerSegments({ segments }: { segments: readonly AnswerSegment[] }) {
  return (
    <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--text-primary)]">
      {segments.map((s, i) =>
        s.kind === "link" && isSameOriginPath(s.href)
          ? <a key={i} href={s.href} className="underline underline-offset-2">{s.text}</a>
          : <span key={i}>{s.text}</span>,
      )}
    </p>
  );
}

export function AnswerCitations({ citations }: { citations: PlatformAiAnswer["citations"] }) {
  if (citations.length === 0) return null;
  return (
    <ul className="mt-4 flex min-w-0 flex-col gap-2 border-t border-[var(--border-hairline)] pt-3">
      {citations.map((c) => (
        <li key={c.metric} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <ToneBadge word={STATUS_WORD[c.status]} tone={STATUS_TONE[c.status]} />
          <span className="min-w-0 break-words font-medium text-[var(--text-primary)]">{c.label}</span>
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

/** The sentence that states the single area a v0 answer comes from. */
export const answeringFrom = (areaLabel: string) => `Answering from ${areaLabel} data`;

export function PlatformAiAsk({ areaLabel }: { areaLabel: string }) {
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<PlatformAiAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || pending) return;
    setPending(true); setError(null);
    try {
      const r = await fetch(PLATFORM_AI_ASK_URL, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }),
      });
      const body = await r.json().catch(() => null) as (PlatformAiAnswer & { reason?: string; error?: string }) | null;
      if (!r.ok || !body || !Array.isArray(body.answer)) {
        setAnswer(null);
        setError((body?.reason && REFUSAL_COPY[body.reason]) ?? (r.status === 429 ? "Too many questions — try again shortly." : "Platform AI is unavailable right now."));
      } else setAnswer(body);
    } catch {
      setError("Platform AI is unavailable right now.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-[60vh] min-w-0 flex-col">
      <header className="flex shrink-0 items-center gap-2.5 pb-3">
        <AiMark />
        <h1 className="text-base font-semibold leading-tight text-[var(--text-primary)]">{PLATFORM_AI_TITLE}</h1>
        <ToneBadge word="Read-only" tone="info" />
      </header>
      <p data-platform-ai-area="" className="min-w-0 break-words text-xs text-[var(--text-secondary)]">
        {answeringFrom(areaLabel)} only. Other areas you can open are not included in v0.
      </p>
      <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-1 flex-col gap-4 py-4">
        <form onSubmit={ask} className="flex min-w-0 flex-col gap-2">
          <label htmlFor="platform-ai-question" className="text-sm text-[var(--text-secondary)]">
            Ask about jobs, providers, costs, incidents or customers. Answers use only the Platform figures you can already see.
          </label>
          <textarea
            id="platform-ai-question"
            value={question}
            maxLength={MAX}
            rows={3}
            onChange={(e) => setQuestion(e.target.value)}
            className="w-full min-w-0 resize-y rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-inset)] p-3 text-sm text-[var(--text-primary)]"
          />
          <div className="flex min-w-0 items-center justify-between gap-3">
            <span className="text-xs tabular-nums text-[var(--text-muted)]">{question.length}/{MAX}</span>
            <button type="submit" disabled={pending || question.trim().length === 0}
              className="shrink-0 rounded-full border border-[var(--border-hairline-strong)] px-4 py-1.5 text-sm font-medium text-[var(--text-primary)] disabled:opacity-50">
              {pending ? "Asking…" : "Ask"}
            </button>
          </div>
        </form>
        {error ? <p role="status" className="min-w-0 break-words text-sm text-[var(--text-secondary)]">{error}</p> : null}
        {answer ? (
          <section aria-label="Answer" className="min-w-0 rounded-xl border border-[var(--border-hairline)] p-4">
            <AnswerSegments segments={answer.answer} />
            {answer.notes.length > 0 ? (
              <ul className="mt-3 flex min-w-0 flex-col gap-1 text-xs text-[var(--text-secondary)]">
                {answer.notes.map((n, i) => <li key={i} className="min-w-0 break-words">{n}</li>)}
              </ul>
            ) : null}
            <AnswerCitations citations={answer.citations} />
            <p className="mt-3 text-[11px] text-[var(--text-muted)]">{answeringFrom(answer.surface)}. Nothing here is saved.</p>
          </section>
        ) : null}
      </div>
    </div>
  );
}
