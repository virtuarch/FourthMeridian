"use client";

/**
 * components/platform/comms/comms-kit.tsx  (Customer Success — Communications Center)
 *
 * The small shared kit the four Communications views are built from:
 *
 *   useCommsRead   a keyed read through the typed client (lib/platform/comms-center/
 *                  client.ts): the url may change (filters, a selected key) and the
 *                  previous answer is never shown as the current one
 *   ReadState      the honest non-data states: loading · coming soon (route not
 *                  deployed) · unavailable (503, never an empty list) · denied · error
 *   ListMeta       checkedAt + the floor / capped notes every list carries
 *   DaySeriesBars  a dense day series where null = not observed (hatched, never 0)
 *                  and withheld = observed small cell (a distinct outlined marker)
 *   CountText      one small-cell-aware count
 *   FilterSelect / Chip / FactList — ≥ 44 px controls below lg, tokens only
 */

import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Clock, Loader2, Lock } from "lucide-react";
import { commsRead, type CommsReadResult } from "@/lib/platform/comms-center/client";
import type { ConsentClass, DaySeries } from "@/lib/notifications/catalog/types";
import { TONE_COLOR, type StatusTone } from "../platform-surface";
import { countCell, dayCells, daySummary, daySummaryText, envelopeNotes, protectedNote, utcStamp, type CountCell } from "./comms-model";

// ── Reads ───────────────────────────────────────────────────────────────────────

/**
 * A read's state. While a NEW url loads, `previous` holds the last answer (of
 * the previous url) so a list can stay visible, dimmed and aria-busy, instead
 * of flashing empty — it is never presented as the current answer. `retry`
 * re-issues the same url (the 503 / error states offer it).
 */
export type CommsRead<T> =
  | { loading: true; result: null; previous?: CommsReadResult<T> | null; retry?: () => void }
  | { loading: false; result: CommsReadResult<T>; retry?: () => void };

/**
 * Read `url` (null ⇒ nothing to read). The answer is stored WITH its url (and
 * attempt), so a changed url reads as loading until its own answer lands.
 */
export function useCommsRead<T>(url: string | null): CommsRead<T> {
  const [attempt, setAttempt] = useState(0);
  const key = url === null ? null : `${attempt}|${url}`;
  const [state, setState] = useState<{ key: string; result: CommsReadResult<T> } | null>(null);
  useEffect(() => {
    if (key === null || url === null) return;
    const ctrl = new AbortController();
    void commsRead<T>(url, { signal: ctrl.signal }).then((result) => {
      if (!ctrl.signal.aborted) setState({ key, result });
    });
    return () => ctrl.abort();
  }, [key, url]);
  const retry = () => setAttempt((a) => a + 1);
  if (key === null || !state || state.key !== key) return { loading: true, result: null, previous: state?.result ?? null, retry };
  return { loading: false, result: state.result, retry };
}

/** The data of an ok read, else null. */
export function okData<T>(r: CommsRead<T>): T | null {
  return !r.loading && r.result.kind === "ok" ? r.result.data : null;
}

/** The PREVIOUS answer's data while a new url loads (render dimmed + aria-busy), else null. */
export function staleData<T>(r: CommsRead<T>): T | null {
  return r.loading && r.previous?.kind === "ok" ? r.previous.data : null;
}

function RetryButton({ onRetry }: { onRetry?: () => void }) {
  if (!onRetry) return null;
  return (
    <button type="button" onClick={onRetry} data-retry
      className="min-h-11 shrink-0 self-start rounded-[var(--radius-sm)] border border-[var(--border-hairline)] px-3 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-8">
      Retry
    </button>
  );
}

const NOTE = "flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--border-hairline)] px-3 py-2.5 text-xs leading-relaxed";

/**
 * Every non-data state, worded honestly. `what` names the thing ("the catalog").
 * `comingSoon` is the explanation a not-yet-deployed endpoint shows.
 */
export function ReadState({ read, what, comingSoon }: { read: CommsRead<unknown>; what: string; comingSoon?: ReactNode }) {
  if (read.loading) {
    return (
      <p role="status" className="flex items-center gap-1.5 py-3 text-xs text-[var(--text-secondary)]">
        <Loader2 size={12} className="animate-spin" aria-hidden /> {read.previous?.kind === "ok" ? `Updating ${what}…` : `Reading ${what}…`}
      </p>
    );
  }
  const r = read.result;
  switch (r.kind) {
    case "ok":
      return null;
    case "coming-soon":
      return (
        <div role="status" className={NOTE} style={{ background: "var(--surface-inset)" }} data-comms-state="coming-soon">
          <Clock size={14} aria-hidden className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
          <div className="min-w-0 text-[var(--text-secondary)]">
            <p className="font-medium text-[var(--text-primary)]">Coming soon</p>
            <p>{comingSoon ?? `The service behind ${what} is not deployed yet.`}</p>
          </div>
        </div>
      );
    case "unavailable":
      return (
        <div role="alert" className={`${NOTE} flex-wrap`} style={{ color: "var(--coral-400)" }} data-comms-state="unavailable">
          <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />
          <p className="min-w-0 flex-1">{`${what[0].toUpperCase()}${what.slice(1)} is unavailable right now (503) — nothing is shown rather than an empty or zero result.`}</p>
          <RetryButton onRetry={read.retry} />
        </div>
      );
    case "denied":
      return (
        <p role="alert" className={NOTE} data-comms-state="denied">
          <Lock size={14} aria-hidden className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
          <span className="min-w-0 text-[var(--text-secondary)]">{r.error}</span>
        </p>
      );
    case "not-found":
      return <p role="status" className="py-3 text-xs text-[var(--text-secondary)]" data-comms-state="not-found">{r.error}</p>;
    case "rate-limited":
    case "error":
      return (
        <div role="alert" className="flex flex-wrap items-center gap-2 py-3 text-xs" style={{ color: "var(--coral-400)" }} data-comms-state={r.kind}>
          <span className="flex min-w-0 items-center gap-1.5"><AlertTriangle size={12} aria-hidden /> {r.error}</span>
          <RetryButton onRetry={read.retry} />
        </div>
      );
  }
}

// ── List metadata ───────────────────────────────────────────────────────────────

export function ListMeta({ checkedAt, floor, capped, nextCursor, extra }: { checkedAt: string; floor: boolean; capped?: boolean; nextCursor?: string | null; extra?: string }) {
  const notes = envelopeNotes({ floor, capped, nextCursor });
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-[11px] text-[var(--text-muted)]" data-list-meta>
      <span className="tabular-nums">
        Checked <time dateTime={checkedAt}>{utcStamp(checkedAt)}</time>
        {extra ? ` · ${extra}` : ""}
        {!floor && !capped && !nextCursor ? " · complete (not a floor, not capped)" : ""}
      </span>
      {notes.map((t) => <span key={t} data-list-note>{t}</span>)}
    </div>
  );
}

// ── Day series ──────────────────────────────────────────────────────────────────

const shortDay = (d: string) => new Date(`${d}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * A dense day series as bars. Not observed = a hatched slot (no bar, never 0);
 * withheld = an outlined marker at the baseline (observed, fewer than 5);
 * observed 0 = an empty slot over the hairline baseline.
 */
export function DaySeriesBars({ series, label, color = "color-mix(in srgb, var(--meridian-400) 75%, transparent)", noun = "send", height = 72 }: {
  series: DaySeries;
  label: string;
  color?: string;
  noun?: string;
  height?: number;
}) {
  const cells = dayCells(series);
  const s = daySummary(series);
  const summary = `${label}: ${daySummaryText(s, noun)}`;
  return (
    <figure className="min-w-0" data-day-series>
      <div role="img" aria-label={summary} className="flex w-full items-end gap-px border-b border-[var(--border-hairline)]" style={{ height }}>
        {cells.map((c) => {
          if (c.state === "not-observed") {
            return (
              <span key={c.day} title={`${shortDay(c.day)}: not observed`} data-day-state="not-observed" className="h-full min-w-0 flex-1"
                style={{ backgroundImage: "repeating-linear-gradient(45deg, color-mix(in srgb, var(--text-muted) 22%, transparent) 0 1px, transparent 1px 5px)" }} />
            );
          }
          if (c.state === "withheld") {
            return (
              <span key={c.day} title={`${shortDay(c.day)}: withheld — fewer than 5`} data-day-state="withheld" className="flex h-full min-w-0 flex-1 items-end">
                <span className="block w-full rounded-[1px] border border-dashed" style={{ height: 8, borderColor: "var(--accent-warning)" }} />
              </span>
            );
          }
          const h = s.max > 0 ? Math.max(c.count! > 0 ? 2 : 0, Math.round((c.count! / s.max) * (height - 4))) : 0;
          return (
            <span key={c.day} title={`${shortDay(c.day)}: ${c.count!.toLocaleString("en-US")}`} data-day-state="observed" className="flex h-full min-w-0 flex-1 items-end">
              <span className="block w-full rounded-t-[1px]" style={{ height: h, background: color }} />
            </span>
          );
        })}
      </div>
      {cells.length > 0 && (
        <div className="mt-1 flex justify-between text-[10px] tabular-nums text-[var(--text-muted)]">
          <span>{shortDay(cells[0].day)}</span>
          <span>{shortDay(cells[cells.length - 1].day)}</span>
        </div>
      )}
      <figcaption className="mt-1 text-[11px] text-[var(--text-muted)]">{daySummaryText(s, noun)}{series.floor ? " · at least (scan limit)" : ""}</figcaption>
    </figure>
  );
}

export function DaySeriesLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-muted)]" aria-label="Day series legend">
      <li className="flex items-center gap-1.5"><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: "color-mix(in srgb, var(--meridian-400) 75%, transparent)" }} />Observed</li>
      <li className="flex items-center gap-1.5"><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px] border border-dashed" style={{ borderColor: "var(--accent-warning)" }} />Withheld (fewer than 5)</li>
      <li className="flex items-center gap-1.5"><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ backgroundImage: "repeating-linear-gradient(45deg, color-mix(in srgb, var(--text-muted) 40%, transparent) 0 1px, transparent 1px 3px)" }} />Not observed</li>
    </ul>
  );
}

// ── Counts ──────────────────────────────────────────────────────────────────────

export function CountText({ cell }: { cell: CountCell }) {
  if (cell.state === "value") return <span className="tabular-nums text-[var(--text-primary)]" data-count-state="value">{cell.text}</span>;
  if (cell.state === "withheld") {
    return <span className="tabular-nums" style={{ color: "var(--accent-warning)" }} data-count-state="withheld" title="Withheld: fewer than 5 people">{cell.text}<span className="sr-only"> (withheld: fewer than 5)</span></span>;
  }
  return <span className="text-[var(--text-muted)]" data-count-state="not-observed" title="Not observed">{cell.text}<span className="sr-only">not observed</span></span>;
}

export const countOf = (value: number | null, withheld: boolean) => <CountText cell={countCell(value, withheld)} />;

// ── Controls ────────────────────────────────────────────────────────────────────

export function FilterSelect({ label, value, options, onChange, anyLabel = "Any" }: {
  label: string;
  value: string | null;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (v: string | null) => void;
  anyLabel?: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
      {label}
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        className="min-h-11 w-full min-w-0 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] bg-transparent px-2 text-xs normal-case tracking-normal text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-8"
      >
        <option value="">{anyLabel}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function Chip({ children, tone = "muted", title }: { children: ReactNode; tone?: StatusTone; title?: string }) {
  return (
    <span title={title} className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium"
      style={{ borderColor: "var(--border-hairline)", color: tone === "muted" ? "var(--text-secondary)" : TONE_COLOR[tone] }}>
      {children}
    </span>
  );
}

export function ProtectedBadge({ consentClass }: { consentClass: ConsentClass }) {
  return (
    <Chip tone="warn" title={protectedNote(consentClass)}>
      <Lock size={10} aria-hidden /> Protected
    </Chip>
  );
}

/** Gives every button inside (e.g. a shared Segmented) a ≥ 44 px width, without forking the shared control. */
export function WideTargets({ children }: { children: ReactNode }) {
  return <span className="inline-flex max-w-full [&_button]:min-w-11" data-wide-targets>{children}</span>;
}

export function FactList({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[var(--text-muted)]">{k}</dt>
          <dd className="min-w-0 break-words text-[var(--text-primary)] max-sm:mb-1">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2 border-t border-[var(--border-hairline)] pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{title}</h3>
      {children}
    </section>
  );
}

export function PolicyNote({ children }: { children: ReactNode }) {
  return <p className="text-[11px] leading-relaxed text-[var(--text-muted)]" data-policy-note>{children}</p>;
}
