"use client";

/**
 * components/platform/widgets/connection-health-table.tsx  (UX-P1 · Agent 3)
 *
 * THE ONE ROW RENDERER for provider connections — the Providers/Pipeline
 * widget and the Overview block both compose it, so a connection reads the
 * same in every place it appears. The house CSS-grid row idiom (Jobs,
 * Pipeline): one `gridTemplateColumns` shared by the header and every row,
 * header suppressed below `md`, where a row collapses to connection + state +
 * last sync and the remaining columns reappear in an inline expansion — a
 * phone loses layout, never a fact.
 *
 * Columns: Connection | State | Last sync | Stale for | Threshold | Owner† | Action
 *   † rendered ONLY when the caller resolved owners through the CUSTOMER_SUCCESS
 *     route (owner decision D4). `owners === null` means the column does not
 *     exist — not blank, not an id.
 *
 * No fetch and no clock of its own except `OwnerResolution`, the keyed-fetch
 * seam both consumers share. Words and tones come from connection-health-view.
 */

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useKeyedFetch } from "../keyed-fetch";
import { KeyRow, ToneBadge, TwoLine, Unavailable } from "../platform-surface";
import type { ConnectionHealthRow } from "@/lib/connections/health";
import type { ConnectionOwnersResponse } from "@/app/api/platform/customer-success/connection-owners/route";
import {
  NO_ACTION_REASON,
  actionWords,
  agoWords,
  describeConnection,
  fmtUtcInstant,
  healthBadge,
  lastSyncCell,
  ownersByRow,
  ownersUrl,
  rowKey,
  staleFor,
  thresholdLabel,
} from "./connection-health-view";

// ── Grid ─────────────────────────────────────────────────────────────────────

/** ONE track list per owner-column variant, shared by header and rows. */
export const CONNECTION_COLS = "minmax(0,1.9fr) 7.5rem minmax(0,1.3fr) 6rem 6rem minmax(0,1.2fr)";
export const CONNECTION_COLS_WITH_OWNER = "minmax(0,1.9fr) 7.5rem minmax(0,1.3fr) 6rem 6rem minmax(0,1fr) minmax(0,1.2fr)";

export function connectionHeadings(withOwner: boolean): readonly string[] {
  return withOwner
    ? ["Connection", "State", "Last sync", "Stale for", "Threshold", "Owner", "Action"]
    : ["Connection", "State", "Last sync", "Stale for", "Threshold", "Action"];
}

export const NEVER_SYNCED_WORD = "never synced";
const NEVER_SYNCED_REASON = "no sync to measure from";
const OWNER_UNRESOLVED_REASON = "owner not resolved";

// ── Cells ─────────────────────────────────────────────────────────────────────

function LastSyncCell({ row, nowMs }: { row: ConnectionHealthRow; nowMs?: number }) {
  const cell = lastSyncCell(row, nowMs);
  if (!cell) return <TwoLine value={NEVER_SYNCED_WORD} qualifier="no successful sync recorded" />;
  return <TwoLine value={cell.value} qualifier={cell.qualifier} />;
}

function StaleForCell({ row, checkedAt }: { row: ConnectionHealthRow; checkedAt: string }) {
  const span = staleFor(row, checkedAt);
  if (span == null) return <Unavailable reason={NEVER_SYNCED_REASON} />;
  return <span className="text-xs tabular-nums text-[var(--text-primary)]">{span}</span>;
}

function OwnerCell({ row, owners }: { row: ConnectionHealthRow; owners: ReadonlyMap<string, string> }) {
  const label = owners.get(rowKey(row));
  if (!label) return <Unavailable reason={OWNER_UNRESOLVED_REASON} />;
  return <span className="text-xs break-words text-[var(--text-primary)]">{label}</span>;
}

function ActionCell({ row, onOpen }: { row: ConnectionHealthRow; onOpen: () => void }) {
  const words = actionWords(row);
  if (!words) return <Unavailable reason={NO_ACTION_REASON} />;
  return (
    <TwoLine
      value={
        <button
          type="button"
          onClick={onOpen}
          className="rounded-[var(--radius-xs)] text-xs text-[var(--meridian-400)] transition-colors hover:text-[var(--meridian-300)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
          aria-label={`Open ${describeConnection(row).title} — ${words}`}
        >
          Open →
        </button>
      }
      qualifier={words}
    />
  );
}

/** One labelled fact inside the below-`md` expansion. */
function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</span>
      <span className="text-xs tabular-nums text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

/**
 * The below-`md` expansion: the columns the collapsed row dropped. Exported
 * so a test can render it directly (a collapsed row's contents are unreachable
 * through `renderToStaticMarkup`, which dispatches no clicks).
 */
export function ConnectionRowDetail({
  row,
  owners,
  checkedAt,
  onOpen,
}: {
  row: ConnectionHealthRow;
  owners: ReadonlyMap<string, string> | null;
  checkedAt: string;
  onOpen: () => void;
}) {
  return (
    <div className="grid gap-x-6 gap-y-3 px-1 pb-4 pt-1 sm:grid-cols-2 md:hidden">
      <Metric label="Stale for" value={<StaleForCell row={row} checkedAt={checkedAt} />} />
      <Metric label="Threshold" value={thresholdLabel(row)} />
      {owners && <Metric label="Owner" value={<OwnerCell row={row} owners={owners} />} />}
      <Metric label="Action" value={<ActionCell row={row} onOpen={onOpen} />} />
    </div>
  );
}

// ── One row ───────────────────────────────────────────────────────────────────

function ConnectionRow({
  row,
  owners,
  checkedAt,
  nowMs,
  onSelect,
}: {
  row: ConnectionHealthRow;
  owners: ReadonlyMap<string, string> | null;
  checkedAt: string;
  nowMs?: number;
  onSelect: (row: ConnectionHealthRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { title, qualifier } = describeConnection(row);
  const badge = healthBadge(row.healthState);
  const cols = owners ? CONNECTION_COLS_WITH_OWNER : CONNECTION_COLS;
  const open = () => onSelect(row);

  return (
    <li
      className="border-b transition-colors last:border-b-0 hover:bg-[var(--surface-hover)]"
      style={{ borderColor: "var(--border-hairline)" }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 md:grid" style={{ gridTemplateColumns: cols, minHeight: 52 }}>
        {/* Connection — the one button that opens the drawer. Nothing interactive
            nests inside it; the Action cell is its own button. */}
        <button
          type="button"
          onClick={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-xs)] py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)] md:flex-none"
          aria-label={`Inspect ${title} (${qualifier})`}
        >
          <TwoLine value={<span className="font-medium">{title}</span>} qualifier={qualifier} />
        </button>

        <span className="shrink-0"><ToneBadge word={badge.word} tone={badge.tone} /></span>

        <span className="basis-full md:basis-auto"><LastSyncCell row={row} nowMs={nowMs} /></span>

        <span className="hidden md:block"><StaleForCell row={row} checkedAt={checkedAt} /></span>
        <span className="hidden text-xs text-[var(--text-primary)] md:block">{thresholdLabel(row)}</span>
        {owners && <span className="hidden md:block"><OwnerCell row={row} owners={owners} /></span>}
        <span className="hidden md:block"><ActionCell row={row} onOpen={open} /></span>

        {/* Below md: the toggle for the dropped columns. */}
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} details for ${title}`}
          className="ml-auto shrink-0 rounded-[var(--radius-sm)] p-1.5 text-[var(--text-faint)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)] md:hidden"
        >
          <ChevronRight size={12} aria-hidden className="transition-transform" style={{ transform: expanded ? "rotate(90deg)" : "none" }} />
        </button>
      </div>
      {expanded && <ConnectionRowDetail row={row} owners={owners} checkedAt={checkedAt} onOpen={open} />}
    </li>
  );
}

// ── Table ─────────────────────────────────────────────────────────────────────

export function ConnectionHealthTable({
  rows,
  owners,
  checkedAt,
  nowMs,
  onSelect,
  emptyMessage = "No connections match.",
}: {
  rows: readonly ConnectionHealthRow[];
  /** Owner labels by row key, or `null` when the column must not exist (no CUSTOMER_SUCCESS read). */
  owners: ReadonlyMap<string, string> | null;
  /** The response's `checkedAt` — the clock "stale for" is measured against. */
  checkedAt: string;
  /** Injected clock for the relative Last-sync word. Omitted in production: the util reads the wall clock. */
  nowMs?: number;
  onSelect: (row: ConnectionHealthRow) => void;
  emptyMessage?: string;
}) {
  const withOwner = owners != null;
  const cols = withOwner ? CONNECTION_COLS_WITH_OWNER : CONNECTION_COLS;
  return (
    /* The table owns its horizontal scroll so the PAGE never scrolls sideways. */
    <div className="overflow-x-auto">
      <div className="mb-1 hidden items-center gap-3 border-b px-1 pb-2 md:grid" style={{ gridTemplateColumns: cols, borderColor: "var(--border-hairline)" }}>
        {connectionHeadings(withOwner).map((h) => (
          <span key={h} className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">{h}</span>
        ))}
      </div>
      <ul className="flex flex-col">
        {rows.length === 0 ? (
          <li className="py-6 text-center text-xs text-[var(--text-muted)]">{emptyMessage}</li>
        ) : (
          rows.map((row) => (
            <ConnectionRow key={rowKey(row)} row={row} owners={owners} checkedAt={checkedAt} nowMs={nowMs} onSelect={onSelect} />
          ))
        )}
      </ul>
    </div>
  );
}

// ── Drawer facts ──────────────────────────────────────────────────────────────

/**
 * The detail panel's fact list — every field the row carries, in the
 * authority's words. The Overview block and the widget share it; the widget
 * adds the WRITE footer beneath.
 */
export function ConnectionFacts({
  row,
  owner,
  checkedAt,
  nowMs,
}: {
  row: ConnectionHealthRow;
  /** Resolved label, or undefined when the column was absent / unresolved. */
  owner?: string;
  checkedAt: string;
  nowMs?: number;
}) {
  const { title, qualifier } = describeConnection(row);
  const badge = healthBadge(row.healthState);
  const sync = lastSyncCell(row, nowMs);
  const span = staleFor(row, checkedAt);
  const words = actionWords(row);
  return (
    <div className="flex flex-col gap-2.5">
      <KeyRow label="Connection" value={title} />
      <KeyRow label="Provider" value={qualifier} />
      <KeyRow label="Judged as" value={row.kind === "BANK" ? "bank (BANK policy)" : "wallet (WALLET policy)"} />
      {row.source !== "PLAID" && <KeyRow label="Network" value={row.network ?? <Unavailable reason="chain not recorded" />} />}
      <KeyRow label="Status" value={row.status} />
      <KeyRow label="Health" value={<ToneBadge word={badge.word} tone={badge.tone} />} />
      <KeyRow label="Last sync" value={sync ? `${sync.value} · ${sync.qualifier}` : NEVER_SYNCED_WORD} />
      <KeyRow label="Stale for" value={span ?? <Unavailable reason={NEVER_SYNCED_REASON} />} />
      <KeyRow label="Threshold" value={thresholdLabel(row)} />
      <KeyRow label="Error code" value={row.errorCode ?? <Unavailable reason="none recorded" />} />
      <KeyRow
        label="Broken since"
        value={row.since ? `${agoWords(row.since, nowMs) ?? "just now"} · ${fmtUtcInstant(row.since) ?? row.since}` : <Unavailable reason="no transition recorded" />}
      />
      {owner !== undefined && <KeyRow label="Owner" value={owner} />}
      <KeyRow label="Operator actions" value={words ?? <Unavailable reason={NO_ACTION_REASON} />} />
    </div>
  );
}

// ── Owner resolution (the CUSTOMER_SUCCESS seam, shared) ─────────────────────

function OwnerLoader({ url, children }: { url: string; children: (owners: ReadonlyMap<string, string> | null) => ReactNode }) {
  const { data } = useKeyedFetch<ConnectionOwnersResponse>(url);
  // Loading, 403 and failure all read as "no column". Only a 200 produces one.
  return <>{children(data ? ownersByRow(data.owners) : null)}</>;
}

/**
 * Resolve owners for the rows on screen through the CUSTOMER_SUCCESS route and
 * hand the result to the children. Remounted per id list (the keyed-fetch
 * contract), so a refetch of the fleet re-resolves honestly. An empty list
 * asks nothing.
 */
export function OwnerResolution({
  rows,
  children,
}: {
  rows: readonly Pick<ConnectionHealthRow, "source" | "id">[];
  children: (owners: ReadonlyMap<string, string> | null) => ReactNode;
}) {
  const url = ownersUrl(rows);
  if (!url) return <>{children(null)}</>;
  return <OwnerLoader key={url} url={url}>{children}</OwnerLoader>;
}
