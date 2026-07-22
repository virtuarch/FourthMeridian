"use client";

/**
 * DailyBriefClient — the Daily Brief as narrative intelligence (v2.5 editorial).
 *
 * Fourth Meridian initiates the conversation once a day. The page now reads
 * top-to-bottom like a briefing (prototype components/brief/Brief.tsx): a dated
 * greeting, one lede that earns the first glance, then what changed, then what
 * needs you, then what can wait (folded). Density and urgency DECREASE down the
 * page — the opposite of a notification feed.
 *
 * The cinematic Earth hero was retired here in favour of the text-first
 * editorial header — the Brief's authority now comes from hierarchy and honest
 * grounding, not a backdrop. (EarthBackground/BriefHero remain in the tree,
 * unused by this route — a v2.6 cleanup, not a dependency.)
 *
 * NOTHING about the data changed: same `fetch("/api/brief")` → `BriefPayload`,
 * same `POST /api/brief/viewed`, same section contract. The production sections
 * map onto the editorial buckets:
 *   insight            → the LEDE (FM's one read for today)
 *   since_last_visit   → "Since you were last here" (the metric quartet)
 *   attention          → "Worth your attention" (or the all-clear line)
 *   opportunity/other  → "Can wait" (folded)
 * The rich detail still lives in the SAME modals (SinceLastVisitModal,
 * AttentionModal), opened from the editorial surfaces.
 *
 * HONESTY: the prototype's trust dot, evidence chips, "Ask about this", and
 * Space-jumps are presentational SLOTS here — a trust dot renders only when an
 * item carries a `basis` (the builder doesn't emit one yet), a jump chip only
 * when an item has an `href`. Nothing is fabricated. "View AI Analysis" opens
 * the existing conversational AI at /dashboard/analyze — the Brief→AI handoff.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, ChevronDown, LayoutGrid, Sparkles, ShieldCheck } from "lucide-react";
import { Surface, Figure } from "@/components/atlas/Surface";
import { BriefNewUser } from "./BriefNewUser";
import { SinceLastVisitModal } from "./SinceLastVisitModal";
import { AttentionModal } from "./AttentionModal";
import type { BriefPayload, BriefSection, BriefItem, BriefBasis, BriefTone, VisitState } from "@/lib/brief-types";

// ── Copy helpers (ported from the retired BriefHero) ────────────────────────────

function formatDateLabel(iso: string): string {
  return new Date(iso).toLocaleString([], {
    weekday: "long",
    day:     "numeric",
    month:   "long",
    hour:    "numeric",
    minute:  "2-digit",
  });
}

function extractFirstName(contextLine: string): string | null {
  const m = contextLine.match(/,\s+([A-Z][a-z]+)/);
  return m ? m[1] : null;
}

function greeting(state: VisitState, firstName: string | null): string {
  if (state === "new_user") return "Welcome to Fourth Meridian";
  const h = new Date().getHours();
  const verb = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return firstName ? `${verb}, ${firstName}.` : `${verb}.`;
}

function statusLine(state: VisitState): string {
  switch (state) {
    case "new_user":  return "Let's build your financial picture.";
    case "immediate": return "You're up to date.";
    case "short":     return "You're up to date.";
    case "day":       return "Here's your daily check-in.";
    case "away":      return "Here's what happened since your last visit.";
  }
}

// A number carries gain/loss colour only when its own tone claims it — never the
// brand. Maps the Brief's tone vocabulary onto the Figure's up/down/neutral.
function figureTone(tone?: BriefTone): "up" | "down" | "neutral" {
  if (tone === "positive") return "up";
  if (tone === "warning" || tone === "danger") return "down";
  return "neutral";
}

// ── Small presentational parts ──────────────────────────────────────────────────

/** Trust provenance dot — renders ONLY when an item carries a `basis`. The
 *  builder does not emit one yet, so this is a seam, never fabricated. */
function TrustDot({ basis }: { basis: BriefBasis }) {
  const observed = basis === "observed";
  const color = observed ? "var(--accent-positive)" : "var(--text-muted)";
  const label = basis === "observed" ? "observed" : basis === "reconstructed" ? "reconstructed" : "partly reconstructed";
  return (
    <span
      aria-label={label}
      title={label}
      className="mt-[7px] inline-block size-2 shrink-0 rounded-full"
      style={{ background: observed ? color : "transparent", boxShadow: `inset 0 0 0 1.5px ${color}` }}
    />
  );
}

/** A jump chip — an honest deep-link, shown only when the item/section has an
 *  href. This is the prototype's `spaceJump`/evidence affordance over the real
 *  `href` the builder already emits (e.g. /dashboard?tab=accounts). */
function JumpChip({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded-full border border-[var(--border-hairline)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] transition-colors duration-[var(--dur-base)] ease-[var(--ease-standard)] hover:border-[var(--border-hairline-strong)] hover:text-[var(--text-primary)]"
    >
      {label}
      <ArrowRight size={11} className="text-[var(--text-muted)]" />
    </Link>
  );
}

/** The Brief→AI handoff — opens the existing conversational AI. */
function AskChip({ href = "/dashboard/analyze", label = "View AI Analysis" }: { href?: string; label?: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded-full border border-[rgba(125,168,255,.32)] px-2.5 py-1 text-[11px] text-[var(--meridian-300)] transition-colors duration-[var(--dur-base)] ease-[var(--ease-standard)] hover:bg-[rgba(125,168,255,.12)]"
    >
      <Sparkles size={11} />
      {label}
    </Link>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{children}</span>
      <span className="h-px flex-1 bg-[var(--border-hairline)]" aria-hidden />
    </div>
  );
}

// ── The lede — FM's one read for today (the `insight` section) ───────────────────

function Lede({ section }: { section: BriefSection }) {
  const body = section.body ?? "";
  if (!body) return null;
  const dest = section.actionHref ?? "/dashboard/analyze";
  const label = section.actionLabel ?? "View AI Analysis";
  return (
    <section className="mb-10">
      <p className="text-base leading-relaxed text-[var(--text-primary)] sm:text-lg max-w-[62ch]">{body}</p>
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <AskChip href={dest} label={label} />
      </div>
    </section>
  );
}

// ── "Since you were last here" — the metric quartet, opens the modal ─────────────

function ChangedBlock({ section }: { section: BriefSection }) {
  const [open, setOpen] = useState(false);
  const items = section.items ?? [];
  if (items.length === 0) return null;

  return (
    <section className="mb-9">
      <SectionLabel>Since you were last here</SectionLabel>
      <Surface className="overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`${section.title} — view activity`}
          className="group block w-full p-4 text-left sm:p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] focus-visible:ring-inset"
        >
          <div className="flex flex-wrap gap-x-10 gap-y-5">
            {items.map((item) => (
              <div key={item.id} className="min-w-0">
                <p className="truncate text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{item.label}</p>
                {item.value && (
                  <div className="mt-1">
                    <Figure value={item.value} size="lede" tone={figureTone(item.tone)} />
                  </div>
                )}
                {item.detail && <p className="mt-1 truncate text-xs text-[var(--text-secondary)]">{item.detail}</p>}
              </div>
            ))}
          </div>
          <span className="mt-4 inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] transition-colors group-hover:text-[var(--text-secondary)]">
            View activity
            <ArrowUpRight size={12} />
          </span>
        </button>
      </Surface>
      <SinceLastVisitModal open={open} onClose={() => setOpen(false)} section={section} />
    </section>
  );
}

// ── "Worth your attention" — accent rows, or the all-clear line ──────────────────

function AttentionBlock({ section }: { section?: BriefSection }) {
  const [open, setOpen] = useState(false);
  const items = (section?.items ?? []).slice(0, 3);
  const hasAlerts = items.length > 0;

  if (!hasAlerts) {
    return (
      <section className="mb-9">
        <SectionLabel>Worth your attention</SectionLabel>
        <div className="flex items-center gap-3 py-1">
          <ShieldCheck size={16} className="shrink-0 text-[var(--accent-positive)]" />
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">Everything looks healthy today.</p>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">No issues detected across your accounts and assets.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mb-9">
      <SectionLabel>Worth your attention</SectionLabel>
      <div className="space-y-2.5">
        {items.map((item) => (
          <Surface key={item.id} className="border-[rgba(224,122,95,.28)]">
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label={`${item.label} — review`}
              className="group block w-full p-4 text-left sm:p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] focus-visible:ring-inset"
            >
              <div className="flex items-baseline gap-2.5">
                {item.basis && <TrustDot basis={item.basis} />}
                <p className="text-[15px] font-medium leading-6 text-[var(--text-primary)]">{item.label}</p>
              </div>
              {item.detail && <p className="mt-1.5 text-xs leading-5 text-[var(--text-secondary)]">{item.detail}</p>}
              {item.value && <p className="mt-1.5 tabular-nums text-sm text-[var(--accent-negative)]">{item.value}</p>}
              <span className="mt-3 inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] transition-colors group-hover:text-[var(--text-secondary)]">
                Review
                <ArrowUpRight size={12} />
              </span>
            </button>
          </Surface>
        ))}
      </div>
      <AttentionModal open={open} onClose={() => setOpen(false)} section={section} />
    </section>
  );
}

// ── "Can wait" — folded away, low urgency ────────────────────────────────────────

function CanWaitBlock({ items }: { items: BriefItem[] }) {
  const [show, setShow] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="mt-10 border-t border-[var(--border-hairline)] pt-5">
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
      >
        Can wait · {items.length}
        <ChevronDown size={12} className={`transition-transform duration-[var(--dur-base)] ${show ? "rotate-180" : ""}`} />
      </button>
      {show && (
        <div className="mt-4 space-y-4">
          {items.map((item) => (
            <div key={item.id}>
              <p className="text-xs font-medium text-[var(--text-secondary)]">{item.label}</p>
              {item.detail && <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">{item.detail}</p>}
              {item.href && (
                <div className="mt-2">
                  <JumpChip href={item.href} label={item.value ?? "Open"} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Skeleton / error ─────────────────────────────────────────────────────────────

function BriefSkeleton() {
  return (
    <div className="mx-auto max-w-[680px] px-5 pt-24 pb-24 md:pt-28">
      <div className="animate-pulse space-y-8">
        <div className="space-y-3">
          <div className="h-3 w-40 rounded bg-[var(--surface-hover)]" />
          <div className="h-8 w-64 rounded bg-[var(--surface-hover)]" />
        </div>
        <div className="space-y-2">
          <div className="h-4 w-full rounded bg-[var(--surface-hover)]" />
          <div className="h-4 w-5/6 rounded bg-[var(--surface-hover)]" />
        </div>
        <div className="h-28 rounded-[var(--radius-lg)] bg-[var(--surface-hover)]" />
        <div className="h-20 rounded-[var(--radius-lg)] bg-[var(--surface-hover)]" />
      </div>
    </div>
  );
}

function BriefError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-[680px] flex-col items-center justify-center gap-4 px-5 text-center">
      <p className="text-sm text-[var(--text-muted)]">Couldn&apos;t load your brief.</p>
      <button
        onClick={onRetry}
        className="text-xs text-[var(--meridian-400)] underline transition-colors hover:text-[var(--meridian-300)]"
      >
        Try again
      </button>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────────

export function DailyBriefClient() {
  const [payload, setPayload] = useState<BriefPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(false);

  // Fetch core — no synchronous setState (state only changes inside the async
  // then/catch callbacks), so it's safe to call directly from the effect below
  // without tripping react-hooks/set-state-in-effect.
  function fetchBrief() {
    fetch("/api/brief")
      .then((res) => {
        if (!res.ok) throw new Error("Failed");
        return res.json() as Promise<BriefPayload>;
      })
      .then((data) => { setPayload(data); setLoading(false); })
      .catch(() => { setError(true); setLoading(false); });
  }

  // Retry — an event handler, so the synchronous resets are fine here.
  function retry() {
    setLoading(true);
    setError(false);
    fetchBrief();
  }

  // Initial load
  useEffect(() => {
    fetchBrief();
  }, []);

  // Mark viewed — best effort, non-blocking
  useEffect(() => {
    if (!payload) return;
    fetch("/api/brief/viewed", { method: "POST" }).catch(() => {});
  }, [payload]);

  if (loading) return <BriefSkeleton />;
  if (error || !payload) return <BriefError onRetry={retry} />;

  const { visitState, contextLine, hasData, sections, generatedAt } = payload;
  const firstName = extractFirstName(contextLine);
  const isNewUser = visitState === "new_user" && !hasData;

  // Bucket the sections into the editorial hierarchy (order is fixed by
  // decreasing urgency, not by section.priority).
  const insight      = sections.find((s) => s.type === "insight");
  const sinceLast    = sections.find((s) => s.type === "since_last_visit");
  const attention    = sections.find((s) => s.type === "attention");
  const canWaitItems = sections
    .filter((s) => s.type === "opportunity" || (!isNewUser && s.type === "onboarding"))
    .flatMap((s) => s.items ?? []);

  return (
    <div className="mx-auto max-w-[680px] px-5 pt-24 pb-24 md:pt-28">
      {/* ── Dated greeting ──────────────────────────────────────────────────── */}
      <header className="mb-9">
        <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
          {formatDateLabel(generatedAt)}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-[28px]">
          {greeting(visitState, firstName)}
        </h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">{statusLine(visitState)}</p>

        {/* The Brief is chrome-less — keep the two portals reachable up top so a
            reader who knows their intent needn't scroll. */}
        {!isNewUser && (
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Link
              href="/dashboard/spaces"
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-hairline)] px-3 py-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--border-hairline-strong)] hover:text-[var(--text-primary)]"
            >
              <LayoutGrid size={13} />
              Continue to Spaces
              <ArrowRight size={12} className="text-[var(--text-muted)]" />
            </Link>
            <Link
              href="/dashboard/analyze"
              className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(125,168,255,.32)] px-3 py-1.5 text-xs text-[var(--meridian-300)] transition-colors hover:bg-[rgba(125,168,255,.12)]"
            >
              <Sparkles size={13} />
              View AI Analysis
            </Link>
          </div>
        )}
      </header>

      {isNewUser ? (
        <BriefNewUser />
      ) : (
        <>
          {insight && <Lede section={insight} />}
          {sinceLast && <ChangedBlock section={sinceLast} />}
          <AttentionBlock section={attention} />
          <CanWaitBlock items={canWaitItems} />
        </>
      )}
    </div>
  );
}
