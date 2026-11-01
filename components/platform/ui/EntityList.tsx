/**
 * components/platform/ui/EntityList.tsx  (Platform Operations 2.0 — R1 primitive)
 *
 * A compact list of entities: name, status (dot + WORD), one or two metrics, a
 * chevron into its detail. R2: an optional one-line `summary` under the name is
 * shown at EVERY width (the metric columns drop out below sm), so a phone keeps
 * the row's meaning, never just its name. Rows are hairline-divided on md+ and become cards
 * below md. A row is ONE target — a link (`href`) or a button (`onSelect`, e.g.
 * opening a DetailDrawer) — at least 44 px tall, with a visible focus ring.
 */

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { ToneBadge, type StatusTone } from "@/components/platform/platform-surface";

export interface EntityRowProps {
  name: string;
  status?: { word: string; tone: StatusTone };
  /** At most two are shown (sm and up). */
  metrics?: readonly { label: string; value: ReactNode }[];
  /** One quiet line under the name, at every width (truncated). */
  summary?: ReactNode;
  href?: string;
  onSelect?: () => void;
  selected?: boolean;
}

const ROW = "flex min-h-11 w-full items-center gap-3 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)] max-md:rounded-[var(--radius-md)] max-md:border max-md:border-[var(--border-hairline)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:bg-[var(--surface-hover)]";

export function EntityRow({ name, status, metrics = [], summary, href, onSelect, selected = false }: EntityRowProps) {
  const content = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
          <span className="truncate text-sm font-medium text-[var(--text-primary)]">{name}</span>
          {status && <ToneBadge word={status.word} tone={status.tone} />}
        </span>
        {summary != null && <span className="truncate text-[11px] text-[var(--text-muted)]">{summary}</span>}
      </span>
      {metrics.slice(0, 2).map((m) => (
        <span key={m.label} className="hidden shrink-0 flex-col items-end sm:flex">
          <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{m.label}</span>
          <span className="text-xs tabular-nums text-[var(--text-primary)]">{m.value}</span>
        </span>
      ))}
      <ChevronRight size={14} aria-hidden className="shrink-0 text-[var(--text-muted)]" />
    </>
  );
  const cls = `${ROW} ${selected ? "bg-[var(--surface-hover)]" : ""}`;
  if (href) return <Link href={href} prefetch={false} aria-current={selected ? "true" : undefined} className={cls}>{content}</Link>;
  return (
    <button type="button" onClick={onSelect} aria-pressed={onSelect ? selected : undefined} className={cls}>
      {content}
    </button>
  );
}

export function EntityList({ label, children, empty }: { label: string; children: ReactNode; empty?: string | null }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children);
  if (!hasRows) return empty ? <p className="text-sm text-[var(--text-secondary)]">{empty}</p> : null;
  return (
    <ul aria-label={label} className="flex flex-col gap-2 md:gap-0 md:divide-y md:divide-[var(--border-hairline)]">
      {Array.isArray(children) ? children.map((c, i) => <li key={i}>{c}</li>) : <li>{children}</li>}
    </ul>
  );
}
