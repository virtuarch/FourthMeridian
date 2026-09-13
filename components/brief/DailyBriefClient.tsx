"use client";

/**
 * DailyBriefClient — the Daily Brief, as a cached daily surface.
 *
 * The flow lives in ./brief-flow (framework-free, tested); this file wires it to
 * the page's lifecycle and renders what it says:
 *
 *   a Brief on screen      → headline, metric row, what deserves attention, what is
 *                            worth knowing, under TWO clocks: when the Brief was
 *                            written (and whether it is updating), and — separately —
 *                            when each source behind the Space last delivered data,
 *                            with the sources that need attention named
 *   nothing safe to show   → the Brief's own shape as a skeleton, one truthful label
 *   no connected accounts  → onboarding
 *
 * ⚠️ RECHECKED, NOT REGENERATED, WHEN THE TAB RETURNS. `visibilitychange` (the tab
 * shown again) and `pageshow` with `persisted` (Safari's back-forward cache) ask
 * the server for the current state, at most once a minute; the server decides
 * whether anything needs doing.
 *
 * ⚠️ MONEY IS CODE'S. The metric row comes from the response's deterministic
 * snapshot figures; nothing is ever read out of the narration.
 */

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, ShieldCheck } from "lucide-react";
import { Surface, Figure } from "@/components/atlas/Surface";
import { formatCurrency } from "@/lib/currency";
import type {
  BriefArtifactView, BriefDataHealthView, BriefMetricsView, BriefObservationView, BriefResponse,
  DataGroupView, DataSourceKind, DataSourceView,
} from "@/lib/brief-types";
import { BriefNewUser } from "./BriefNewUser";
import {
  browserClock, createBriefController, httpBriefTransport, initialView,
  type BriefController, type BriefView,
} from "./brief-flow";

// ── Formatting (browser-local time; the Brief day itself is a UTC day) ──────────

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
const utcDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString([], {
  weekday: "long", month: "short", day: "numeric", timeZone: "UTC",
});

/** "today" / "yesterday" / "Sep 10", in the browser's calendar. */
const relDay = (iso: string) => {
  const d = new Date(iso);
  const n = new Date();
  const days = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
    - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : shortDate(iso);
};

function greeting(firstName: string | null): string {
  const h = new Date().getHours();
  const verb = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return firstName ? `${verb}, ${firstName}.` : `${verb}.`;
}

// ── Pieces ─────────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <h2 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{children}</h2>
      <span className="h-px flex-1 bg-[var(--border-hairline)]" aria-hidden />
    </div>
  );
}

/** Clock one: when the Brief was written, and whether it is being reconsidered. */
function Provenance({ brief, phase }: { brief: BriefArtifactView; phase: BriefView["phase"] }) {
  const status = phase === "UPDATING" || phase === "WAITING" ? "Updating…"
    : phase === "COULD_NOT_UPDATE" ? "Couldn’t update" : null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-muted)]">
      <span suppressHydrationWarning>
        {brief.fromPriorDay ? `From ${utcDay(brief.briefDay)} · ` : ""}Brief updated {time(brief.generatedAt)}
      </span>
      <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5">
        {status && (
          <>
            <span aria-hidden>·</span>
            {status === "Updating…" && <span className="presence-dot size-1.5 rounded-full bg-[var(--meridian-400)]" aria-hidden />}
            <span className={status === "Couldn’t update" ? "text-[var(--accent-warning)]" : "text-[var(--text-secondary)]"}>{status}</span>
          </>
        )}
      </span>
    </p>
  );
}

const GROUP_NAME: Record<DataSourceKind, string> = { BANK: "Banks", WALLET: "Crypto", MANUAL: "Manual" };

/** A provider group never reads better than its worst source: attention first, then its OLDEST update. */
function groupPhrase(g: DataGroupView): string {
  if (g.attention > 0) {
    return g.sources === 1 ? "needs attention" : `${g.attention} of ${g.sources} ${g.attention === 1 ? "needs" : "need"} attention`;
  }
  return g.oldestUpdatedAt ? `updated ${relDay(g.oldestUpdatedAt)}` : "not updated yet";
}

function sourceStatus(s: DataSourceView): string {
  const since = s.lastUpdatedAt ? shortDate(s.lastUpdatedAt) : null;
  switch (s.state) {
    case "CURRENT":          return s.lastUpdatedAt ? `Updated ${relDay(s.lastUpdatedAt)}` : "Up to date";
    case "IMPORTING":        return "Still importing";
    case "OUT_OF_DATE":      return since ? `Hasn’t updated since ${since}` : "Hasn’t updated recently";
    case "NEEDS_RECONNECT":  return since ? `Needs to be reconnected · last updated ${since}` : "Needs to be reconnected";
    case "CONNECTION_ERROR": return since ? `Connection error · last updated ${since}` : "Connection error";
    case "SYNC_INCOMPLETE":  return since ? `Last update didn’t finish · data from ${since}` : "Last update didn’t finish";
    case "DISCONNECTED":     return since ? `Disconnected · last updated ${since}` : "Disconnected";
    case "NEVER_UPDATED":    return "Hasn’t updated yet";
  }
}

/** One sentence naming the source — never a reason the data does not contain. */
function attentionSentence(s: DataSourceView): string {
  const since = s.lastUpdatedAt ? shortDate(s.lastUpdatedAt) : null;
  switch (s.state) {
    case "NEEDS_RECONNECT":  return `${s.label} needs to be reconnected`;
    case "CONNECTION_ERROR": return `${s.label} has a connection error`;
    case "SYNC_INCOMPLETE":  return `${s.label}’s last update didn’t finish`;
    case "DISCONNECTED":     return `${s.label} is disconnected`;
    case "OUT_OF_DATE":      return since ? `${s.label} hasn’t updated since ${since}` : `${s.label} hasn’t updated recently`;
    default:                 return `${s.label} hasn’t updated yet`;
  }
}

function sourceHint(s: DataSourceView): string | null {
  if (!s.needsAttention) return null;
  if (s.kind === "MANUAL") return "Update the balance on the account itself.";
  return s.actionable ? null : "The member who connected it can fix this.";
}

/**
 * Clock two: when the money was last observed. A summary per provider group, the
 * first source needing attention named in the open, and every source behind a
 * disclosure. Rendered from the GET's data health — no request of its own.
 */
function DataFreshness({ dataHealth, brief }: { dataHealth: BriefDataHealthView | null; brief: BriefArtifactView }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!dataHealth || dataHealth.sources.length === 0) {
    // No per-source detail could be read: only then is the generic line all that can be said.
    if (brief.balancesMayBeStale) return <p className="mt-1 text-xs text-[var(--accent-warning)]">Some balances may be out of date</p>;
    return brief.balancesAsOf
      ? <p className="mt-1 text-xs text-[var(--text-muted)]" suppressHydrationWarning>Balances last checked {shortDate(brief.balancesAsOf)}</p>
      : null;
  }
  const attention = dataHealth.sources.filter((s) => s.needsAttention);
  const first = attention[0];
  const link = "rounded underline decoration-[var(--border-hairline-strong)] underline-offset-2 transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--meridian-400)]";
  return (
    <div className="mt-1 text-xs">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="-mx-1 inline-flex min-h-[32px] max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded px-1 text-left text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--meridian-400)]"
      >
        <span>Financial data</span>
        {dataHealth.groups.map((g) => (
          <span key={g.kind} className="inline-flex items-center gap-1.5" suppressHydrationWarning>
            <span aria-hidden>·</span>
            <span className={g.attention > 0 ? "text-[var(--accent-warning)]" : undefined}>{GROUP_NAME[g.kind]} {groupPhrase(g)}</span>
          </span>
        ))}
        <ChevronDown size={12} aria-hidden className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {first && (
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[var(--accent-warning)]" suppressHydrationWarning>
          <span>{attentionSentence(first)}{attention.length > 1 ? ` · ${attention.length - 1} more` : ""}</span>
          {attention.some((s) => s.actionable) && (
            <Link href="/dashboard/connections" className={`${link} text-[var(--text-secondary)]`}>Review connections</Link>
          )}
        </p>
      )}
      <div id={panelId} hidden={!open}>
        <ul className="mt-2 divide-y divide-[var(--border-hairline)] rounded-[var(--radius-md)] border border-[var(--border-hairline)]">
          {dataHealth.sources.map((s, i) => {
            const hint = sourceHint(s);
            return (
              <li key={`${s.kind}-${i}`} className="px-3 py-2">
                <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                  <span className="text-[var(--text-primary)]">
                    {s.label}
                    <span className="text-[var(--text-muted)]"> · {s.accountCount} {s.accountCount === 1 ? "account" : "accounts"}</span>
                  </span>
                  <span className={s.needsAttention ? "text-[var(--accent-warning)]" : "text-[var(--text-secondary)]"} suppressHydrationWarning>
                    {sourceStatus(s)}
                  </span>
                </div>
                {hint && <p className="mt-0.5 text-[var(--text-muted)]">{hint}</p>}
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[var(--text-muted)]">
          Dates show when Fourth Meridian last received data from each source, not when your Brief was written.{" "}
          <Link href="/dashboard/connections" className={link}>Manage connections</Link>
        </p>
      </div>
    </div>
  );
}

function Metrics({ metrics }: { metrics: BriefMetricsView }) {
  const change = metrics.monthChange;
  return (
    <Surface className="mb-9 p-4 sm:p-5">
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Net worth</p>
      <div className="mt-1">
        <Figure value={formatCurrency(metrics.netWorth, metrics.currency)} size="figure" />
      </div>
      <p className="mt-1 text-xs text-[var(--text-secondary)]" suppressHydrationWarning>
        {change && change.abs !== 0
          ? `${change.abs > 0 ? "+" : "−"}${formatCurrency(Math.abs(change.abs), metrics.currency)} since ${shortDate(`${change.fromDate}T00:00:00Z`)} · `
          : ""}
        as of {shortDate(`${metrics.asOf}T00:00:00Z`)}{metrics.estimated ? " · estimated" : ""}
      </p>
    </Surface>
  );
}

function Observation({ o, quietStyle }: { o: BriefObservationView; quietStyle?: boolean }) {
  const needsConnections = o.kind === "DATA_QUALITY";
  if (quietStyle) {
    return (
      <li>
        <h3 className="text-sm font-medium text-[var(--text-primary)]">{o.title}</h3>
        <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">{o.body}</p>
      </li>
    );
  }
  return (
    <Surface as="li" className="p-4 sm:p-5">
      <h3 className="text-[15px] font-medium leading-6 text-[var(--text-primary)]">{o.title}</h3>
      <p className="mt-1.5 text-sm leading-6 text-[var(--text-secondary)]">{o.body}</p>
      {needsConnections && (
        <Link href="/dashboard/connections"
          className="mt-3 inline-flex items-center gap-1 rounded-full border border-[var(--border-hairline)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-hairline-strong)] hover:text-[var(--text-primary)]">
          Review connections <ArrowRight size={11} aria-hidden />
        </Link>
      )}
    </Surface>
  );
}

function BriefBody({ brief, metrics, dataHealth, phase }: {
  brief: BriefArtifactView; metrics: BriefMetricsView | null; dataHealth: BriefDataHealthView | null; phase: BriefView["phase"];
}) {
  const notable = brief.observations.filter((o) => o.importance === "NOTABLE");
  const context = brief.observations.filter((o) => o.importance === "CONTEXT");
  return (
    <>
      <div className="mb-8">
        <Provenance brief={brief} phase={phase} />
        <DataFreshness dataHealth={dataHealth} brief={brief} />
        <p className="mt-3 max-w-[62ch] text-lg font-medium leading-relaxed text-[var(--text-primary)] sm:text-xl">{brief.headline}</p>
      </div>

      {metrics && <Metrics metrics={metrics} />}

      {notable.length > 0 && (
        <section className="mb-9" aria-label="Worth your attention">
          <SectionLabel>Worth your attention</SectionLabel>
          <ul className="space-y-2.5">{notable.map((o, i) => <Observation key={`n${i}`} o={o} />)}</ul>
        </section>
      )}

      {brief.observations.length === 0 && (
        <div className="mb-9 flex items-center gap-3 py-1">
          <ShieldCheck size={16} className="shrink-0 text-[var(--accent-positive)]" aria-hidden />
          <p className="text-sm text-[var(--text-secondary)]">Nothing major changed.</p>
        </div>
      )}

      {context.length > 0 && (
        <section className="mb-9" aria-label="Worth knowing">
          <SectionLabel>Worth knowing</SectionLabel>
          <ul className="space-y-4">{context.map((o, i) => <Observation key={`c${i}`} o={o} quietStyle />)}</ul>
        </section>
      )}
    </>
  );
}

/** The Brief's own shape, pulsing. One truthful label; no invented stages. */
function BriefSkeleton() {
  const bar = "rounded bg-[var(--surface-hover)]";
  return (
    <div>
      <p role="status" aria-live="polite" className="text-xs text-[var(--text-muted)]">Preparing your brief…</p>
      <div className="animate-pulse" aria-hidden>
        <div className="mb-8 mt-3 space-y-2">
          <div className={`h-5 w-full ${bar}`} />
          <div className={`h-5 w-4/5 ${bar}`} />
        </div>
        <div className="mb-9 h-[92px] rounded-[var(--radius-lg)] bg-[var(--surface-hover)]" />
        <div className={`mb-3 h-2.5 w-32 ${bar}`} />
        <div className="space-y-2.5">
          <div className="h-[88px] rounded-[var(--radius-lg)] bg-[var(--surface-hover)]" />
          <div className="h-[88px] rounded-[var(--radius-lg)] bg-[var(--surface-hover)]" />
        </div>
      </div>
    </div>
  );
}

function BriefError({ message, onRetry, retryAt }: { message: string; onRetry: () => void; retryAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  const waitMs = retryAt !== null ? retryAt - now : 0;
  useEffect(() => {
    if (retryAt === null || retryAt <= Date.now()) return;
    const h = setTimeout(() => setNow(Date.now()), retryAt - Date.now() + 50);
    return () => clearTimeout(h);
  }, [retryAt]);
  const minutes = Math.ceil(waitMs / 60_000);
  return (
    <div role="alert" className="flex min-h-[40vh] flex-col items-center justify-center gap-4 text-center">
      <p className="text-sm text-[var(--text-muted)]">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        disabled={waitMs > 0}
        className="text-xs text-[var(--meridian-400)] underline transition-colors hover:text-[var(--meridian-300)] disabled:cursor-not-allowed disabled:text-[var(--text-muted)] disabled:no-underline"
      >
        {waitMs > 0 ? `Try again in ${minutes} min` : "Try again"}
      </button>
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function DailyBriefClient({ spaceId, spaceName, firstName, initial }: {
  spaceId: string;
  spaceName: string;
  firstName: string | null;
  initial: BriefResponse | null;
}) {
  const [view, setView] = useState<BriefView>(() => initialView(initial));
  const controllerRef = useRef<BriefController | null>(null);
  // The server-rendered state belongs to the first mount of this Space only.
  const initialRef = useRef(initial);

  useEffect(() => {
    const controller = createBriefController({
      spaceId, initial: initialRef.current, transport: httpBriefTransport, clock: browserClock, onView: setView,
    });
    controllerRef.current = controller;
    controller.start();

    const onVisibility = () => { if (document.visibilityState === "visible") controller.onVisible(); };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) controller.onVisible(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      controller.dispose();
      controllerRef.current = null;
    };
  }, [spaceId]);

  const retry = () => controllerRef.current?.retry();
  const { phase, brief, metrics, dataHealth, retryAt } = view;

  return (
    <div className="mx-auto w-full max-w-[680px]">
      <header className="mb-6">
        <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]" suppressHydrationWarning>
          {new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-[28px]" suppressHydrationWarning>
          {greeting(firstName)}
        </h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">Your brief for {spaceName}</p>
      </header>

      {phase === "NO_DATA" ? (
        <BriefNewUser />
      ) : brief ? (
        <BriefBody brief={brief} metrics={metrics} dataHealth={dataHealth} phase={phase} />
      ) : phase === "FAILED_EMPTY" ? (
        <BriefError message="Your brief couldn’t be prepared right now." onRetry={retry} retryAt={retryAt} />
      ) : phase === "LOAD_ERROR" ? (
        <BriefError message="Couldn’t load your brief." onRetry={retry} retryAt={null} />
      ) : (
        <BriefSkeleton />
      )}
    </div>
  );
}
