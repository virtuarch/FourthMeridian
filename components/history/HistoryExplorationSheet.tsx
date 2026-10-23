"use client";

/**
 * components/history/HistoryExplorationSheet.tsx
 *
 * THE shared historical exploration panel. One sheet for every stock lens and
 * every node type — lens, bucket, account, holding.
 *
 * ── What this component is not allowed to do ─────────────────────────────────
 * ANY financial arithmetic. It never sums children, never computes a remainder,
 * never decides assertability, never classifies reconciliation, never infers
 * provenance or a supported interval. Every number, state, reason, count and
 * label arrives already decided from `/history/node`, which is a thin gate over
 * the canonical authorities.
 *
 * The one thing it may compute is a PERCENTAGE FOR DISPLAY — `explained /
 * displayed` — and even that is rendered only where the authority already said
 * PARTIALLY_ATTRIBUTED. It changes no value and decides nothing.
 *
 * ── Navigation ───────────────────────────────────────────────────────────────
 * The URL owns it (see exploration-url.ts). Drilling pushes history; back pops
 * it; a refresh or a pasted link restores the same node, date and window. The
 * breadcrumb is the resolver's own `path`, never assembled here — a UI-owned
 * path could disagree with the data about who the parent is.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, ChevronRight } from "lucide-react";
import { Panel } from "@/components/atlas/panels/Panel";
import { PanelHeader, PanelContent } from "@/components/atlas/panels/PanelParts";
import type { ExplorationNodeType } from "@/lib/history/exploration";

// ── The transport, mirrored (no import of a server module into the client) ───

interface SeriesPoint {
  dateISO: string;
  value: number | null;
  basis: "observed" | "reconstructed";
  unavailableReason?: string;
}
interface Crumb { id: string; label: string; nodeType: string }
interface Provenance {
  basis: "observed" | "reconstructed";
  tier: string;
  supportedFromISO: string | null;
  supportedToISO: string | null;
  note: string | null;
}
export interface ExplorationNode {
  id: string;
  nodeType: ExplorationNodeType;
  label: string;
  dateISO: string; fromISO: string; toISO: string; currency: string;
  displayedValue: number | null;
  explainedValue: number | null;
  unattributedObservedAmount: number | null;
  reconciliation: "EXACT" | "PARTIALLY_ATTRIBUTED" | "UNAVAILABLE" | "CONTRADICTORY";
  assertable: boolean;
  unavailableReason: string | null;
  provenance: Provenance;
  breadcrumb: Crumb[];
  components: ExplorationNode[];
  drilldown: { available: boolean; reason: string | null };
  series?: SeriesPoint[];
  historicalCount?: number;
  valuedCount?: number;
  explainedAssets?: number | null;
  explainedLiabilities?: number | null;
  subtracts?: boolean;
  accountType?: string;
  institution?: string | null;
  symbol?: string | null;
  assetClass?: string;
  quantity?: number | null;
  unitPrice?: number | null;
  ownershipEpisodes?: { fromISO: string; toISO: string }[];
  scope?: {
    heldValued: number; heldUnavailable: number; notYetOwned: number;
    alreadyClosed: number; ownershipUncertain: number; excludedArtifact: number;
  };
}

export interface HistoryExplorationSheetProps {
  spaceId: string;
  open: boolean;
  /** The node to show. Changing it re-fetches; the sheet stays open throughout. */
  nodeType: ExplorationNodeType;
  nodeId: string | null;
  dateISO: string;
  fromISO: string;
  toISO: string;
  /** The question being asked. Carried through to the resolver. */
  root?: string;
  /** Drill deeper. The caller writes the URL; this component never routes. */
  onNavigate: (nodeType: ExplorationNodeType, nodeId: string | null) => void;
  onClose: () => void;
}

const money = (v: number | null, currency: string) =>
  v == null
    ? "—"
    : new Intl.NumberFormat(undefined, {
        style: "currency", currency, maximumFractionDigits: 2,
      }).format(v);

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
  });

/** Presentation only — the authority already decided which state applies. */
const STATE_COPY: Record<ExplorationNode["reconciliation"], { label: string; accent: string }> = {
  EXACT:                { label: "Fully explained",         accent: "--accent-positive" },
  PARTIALLY_ATTRIBUTED: { label: "Partly explained",        accent: "--accent-warning" },
  UNAVAILABLE:          { label: "Composition unavailable", accent: "--accent-neutral" },
  CONTRADICTORY:        { label: "Evidence conflicts",      accent: "--accent-negative" },
};

/** Atlas semantic tone — never a raw palette value (palette ratchet). */
const toneStyle = (accent: string) => ({
  color: `var(${accent})`,
  borderColor: `color-mix(in oklab, var(${accent}) 35%, transparent)`,
  backgroundColor: `color-mix(in oklab, var(${accent}) 12%, transparent)`,
});

export function HistoryExplorationSheet(props: HistoryExplorationSheetProps) {
  const { spaceId, open, nodeType, nodeId, dateISO, fromISO, toISO, root: lens = "net-worth" } = props;

  // ONE state object, stamped with the request it answers. Two booleans
  // (`loading` + `data`) can disagree; a stamped answer cannot, and it is what
  // makes an out-of-order response impossible to render.
  const [answer, setAnswer] = useState<{
    key: string; node: ExplorationNode | null; path: Crumb[]; error: string | null;
  } | null>(null);

  const key = `${lens}|${nodeType}|${nodeId ?? ""}|${dateISO}|${fromISO}|${toISO}`;

  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    const params = new URLSearchParams({
      root: lens, type: nodeType, date: dateISO, from: fromISO, to: toISO,
    });
    if (nodeId) params.set("id", nodeId);
    fetch(`/api/spaces/${spaceId}/history/node?${params}`, { signal: ctl.signal })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) return { node: null, path: [], error: body?.error ?? "REQUEST_FAILED" };
        return { node: body.node as ExplorationNode, path: (body.path ?? []) as ExplorationNode[], error: null };
      })
      .then((res) => {
        if (ctl.signal.aborted) return;
        setAnswer({
          key, node: res.node,
          path: (res.path as unknown as ExplorationNode[]).map((p) => ({
            id: p.id, label: p.label, nodeType: p.nodeType,
          })),
          error: res.error,
        });
      })
      .catch((e) => {
        if (e?.name === "AbortError") return;
        setAnswer({ key, node: null, path: [], error: "REQUEST_FAILED" });
      });
    return () => ctl.abort();
  }, [open, spaceId, lens, nodeType, nodeId, dateISO, fromISO, toISO, key]);

  const loading = !answer || answer.key !== key;
  const node = loading ? null : answer.node;
  const path = loading ? [] : answer.path;

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (open && !loading) headingRef.current?.focus();
  }, [open, loading, key]);

  const goto = useCallback(
    (t: ExplorationNodeType, id: string | null) => props.onNavigate(t, id),
    [props],
  );

  return (
    <Panel
      open={open}
      onClose={props.onClose}
      side="right"
      size="lg"
      ariaLabel={`Historical detail for ${longDate(dateISO)}`}
    >
      <PanelHeader
        eyebrow={`${longDate(dateISO)} · ${longDate(fromISO)} → ${longDate(toISO)}`}
        title={node?.label ?? "Historical detail"}
      />
      <PanelContent>
        {/* Breadcrumb — the resolver's own path, never assembled here. */}
        {path.length > 1 && (
          <nav aria-label="Exploration path" className="mb-4 flex flex-wrap items-center gap-1 text-xs">
            {path.map((c, i) => {
              const last = i === path.length - 1;
              return (
                <span key={c.id} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight className="h-3 w-3 text-faint" aria-hidden />}
                  {last ? (
                    <span aria-current="page" className="text-secondary">{c.label}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => goto(c.nodeType as ExplorationNodeType, c.nodeType === "lens" ? null : c.id)}
                      className="rounded px-1 text-[var(--accent-info)] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]"
                    >
                      {c.label}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>
        )}

        {loading && (
          <div className="flex items-center gap-2 py-10 text-sm text-muted" role="status" aria-live="polite">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading historical detail…
          </div>
        )}

        {!loading && answer?.error && (
          <p role="status" className="py-10 text-sm text-muted">
            {answer.error === "NODE_NOT_FOUND"
              ? "This item has no historical record on the selected date."
              : "Historical detail could not be loaded."}
          </p>
        )}

        {!loading && node && <NodeBody node={node} onNavigate={goto} headingRef={headingRef} />}
      </PanelContent>
    </Panel>
  );
}

function NodeBody({
  node, onNavigate, headingRef,
}: {
  node: ExplorationNode;
  onNavigate: (t: ExplorationNodeType, id: string | null) => void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const state = STATE_COPY[node.reconciliation];
  const currency = node.currency;

  // DISPLAY ONLY. Never used to derive, correct or validate a value.
  const explainedPct = useMemo(() => {
    if (node.reconciliation !== "PARTIALLY_ATTRIBUTED") return null;
    if (node.displayedValue == null || node.explainedValue == null || node.displayedValue === 0) return null;
    return Math.round((node.explainedValue / node.displayedValue) * 100);
  }, [node]);

  // A composition may be shown ONLY for the two states that permit it. The
  // authority decides; this is the single place the decision is honoured.
  const mayShowChildren =
    node.reconciliation === "EXACT" || node.reconciliation === "PARTIALLY_ATTRIBUTED";

  return (
    <div className="space-y-6">
      <section>
        {/* The node's OWN label. Hard-coding "Net worth" for every lens root was
            the Net-Worth monopoly surviving in the copy after the architecture
            had already stopped assuming it. */}
        <h3 ref={headingRef} tabIndex={-1} className="text-xs uppercase tracking-wide text-faint focus:outline-none">
          {node.label}
        </h3>
        <p className="mt-1 text-3xl font-semibold tabular-nums text-primary">
          {money(node.displayedValue, currency)}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="rounded-full border px-2 py-0.5 text-[11px]" style={toneStyle(state.accent)}>{state.label}</span>
          <span className="rounded-full border border-hairline bg-[var(--surface-raised)] px-2 py-0.5 text-[11px] text-muted">
            {node.provenance.basis === "observed" ? "Observed" : "Reconstructed"} · {node.provenance.tier}
          </span>
          {node.nodeType === "account" && node.institution && (
            <span className="text-[11px] text-faint">{node.institution} · {node.accountType}</span>
          )}
          {node.nodeType === "holding" && (
            <span className="text-[11px] text-faint">{node.assetClass}</span>
          )}
          {node.nodeType === "tier" && (
            <span className="text-[11px] text-faint">Liquidity tier</span>
          )}
        </div>
        {node.provenance.note && (
          <p className="mt-2 text-xs leading-relaxed text-muted">{node.provenance.note}</p>
        )}
      </section>

      {/* Supported interval — the honest answer to "why is the chart short?" */}
      {node.provenance.supportedFromISO && (
        <p className="text-xs text-muted">
          History available from {longDate(node.provenance.supportedFromISO)}.
        </p>
      )}

      {node.nodeType === "holding" && <HoldingFacts node={node} />}

      <NodeSeries node={node} />

      {/* ── Reconciliation ────────────────────────────────────────────────── */}
      {node.reconciliation === "PARTIALLY_ATTRIBUTED" && node.unattributedObservedAmount != null && (
        <section className="rounded-lg border p-3" style={toneStyle("--accent-warning")}>
          <p className="text-xs leading-relaxed">
            Fourth Meridian recorded the total directly on this date, but the available evidence does
            not allocate {money(node.unattributedObservedAmount, currency)} to a specific component.
            {explainedPct != null && <> {explainedPct}% is explained below.</>}
          </p>
        </section>
      )}
      {node.reconciliation === "CONTRADICTORY" && (
        <section className="rounded-lg border p-3" style={toneStyle("--accent-negative")}>
          <p className="text-xs leading-relaxed">
            Historical composition is unavailable because the stored observations conflict.
          </p>
        </section>
      )}
      {node.reconciliation === "UNAVAILABLE" && (
        <section className="rounded-lg border border-hairline p-3" style={toneStyle("--accent-neutral")}>
          <p className="text-xs leading-relaxed">
            Composition is unavailable for this date
            {node.unavailableReason ? <> — <span className="text-muted">{humanReason(node.unavailableReason)}</span></> : "."}
          </p>
        </section>
      )}

      {/* ── Children ──────────────────────────────────────────────────────── */}
      {mayShowChildren && node.components.length > 0 && (
        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h4 className="text-xs uppercase tracking-wide text-faint">
              {node.nodeType === "lens" ? "Components" : node.nodeType === "bucket" ? "Accounts" : "Holdings"}
            </h4>
            {node.historicalCount != null && (
              <span className="text-[11px] text-faint">
                {node.valuedCount} of {node.historicalCount} valued
              </span>
            )}
          </div>
          <ul className="space-y-1">
            {node.components.map((c) => (
              <ChildRow key={c.id} child={c} currency={currency} onNavigate={onNavigate} />
            ))}
          </ul>
          {node.explainedValue != null && (
            <p className="mt-2 text-[11px] text-faint">
              Explained: {money(node.explainedValue, currency)}
              {node.explainedAssets != null && node.explainedLiabilities != null && (
                <> · assets {money(node.explainedAssets, currency)} · liabilities {money(node.explainedLiabilities, currency)}</>
              )}
            </p>
          )}
        </section>
      )}

      {/* SECONDARY SCOPE — what the primary list deliberately omits, and why.
          "Three positions are missing" and "three were acquired later" are
          different facts; showing only the first teaches the reader the wrong
          one. Counts are the ownership engine's, never recomputed here. */}
      {node.scope && <ScopeSummary scope={node.scope} />}

      {mayShowChildren && node.components.length === 0 && humanReason(node.drilldown.reason ?? "") && (
        <p className="text-xs text-muted">{humanReason(node.drilldown.reason ?? "")}</p>
      )}
    </div>
  );
}

function ChildRow({
  child, currency, onNavigate,
}: {
  child: ExplorationNode;
  currency: string;
  onNavigate: (t: ExplorationNodeType, id: string | null) => void;
}) {
  // NAVIGABLE ≠ DRILLABLE. `drilldown.available` answers "is there a level
  // BELOW this node" — false for a holding, which is the deepest level. But
  // opening the holding itself is still a valid move, and it is where quantity,
  // price, provenance and ownership episodes live. Conflating the two hid the
  // entire holding view behind a flag that was never about navigation.
  const drillable =
    child.assertable && (child.drilldown.available || child.nodeType === "holding");
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate text-left">
        {child.label}
        {child.subtracts && <span className="ml-1 text-[10px] text-faint">(owed)</span>}
      </span>
      <span className="shrink-0 tabular-nums text-secondary">
        {child.displayedValue == null ? "—" : money(child.displayedValue, currency)}
      </span>
    </>
  );
  return (
    <li>
      {drillable ? (
        <button
          type="button"
          onClick={() => onNavigate(child.nodeType, child.id)}
          className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm text-secondary hover:bg-[var(--surface-raised)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)] min-h-11"
        >
          {body}
          <ChevronRight className="h-4 w-4 shrink-0 text-faint" aria-hidden />
        </button>
      ) : (
        <div className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm text-muted min-h-11">
          {body}
          <span className="w-4 shrink-0" aria-hidden />
        </div>
      )}
      {child.displayedValue == null && child.unavailableReason && (
        <p className="px-2 pb-1 text-[11px] text-faint">{humanReason(child.unavailableReason)}</p>
      )}
    </li>
  );
}

/** Holding facts, every one already resolved by the authority. */
function HoldingFacts({ node }: { node: ExplorationNode }) {
  const eps = node.ownershipEpisodes ?? [];
  return (
    <section className="grid grid-cols-2 gap-3 rounded-lg border border-hairline bg-[var(--surface-raised)] p-3 text-xs">
      <Fact label="Quantity" value={node.quantity == null ? "—" : String(node.quantity)} />
      <Fact label="Unit price" value={node.unitPrice == null ? "—" : money(node.unitPrice, node.currency)} />
      <Fact label="Symbol" value={node.symbol ?? "—"} />
      <Fact
        label={eps.length > 1 ? `Held in ${eps.length} periods` : "Held"}
        value={eps.length === 0 ? "not held" : `${eps[0].fromISO} → ${eps[eps.length - 1].toISO}`}
      />
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-faint">{label}</div>
      <div className="tabular-nums text-secondary">{value}</div>
    </div>
  );
}

/**
 * The node's own chart, plus the textual summary a screen reader needs.
 *
 * Gaps are NOT bridged: a date with no assertable value is a real hole in the
 * evidence, and joining across it would draw a line the data does not support.
 */
function NodeSeries({ node }: { node: ExplorationNode }) {
  const pts = node.series ?? [];
  const valued = pts.filter((p) => p.value != null);
  if (pts.length === 0) return null;

  const values = valued.map((p) => p.value as number);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;
  const gaps = pts.length - valued.length;

  const summary =
    `${valued.length} of ${pts.length} days valued between ${longDate(pts[0].dateISO)} and ` +
    `${longDate(pts[pts.length - 1].dateISO)}` +
    (gaps > 0 ? `; ${gaps} day(s) have no assertable value.` : ".");

  return (
    <section>
      <h4 className="mb-1 text-xs uppercase tracking-wide text-faint">Over this range</h4>
      <svg
        viewBox={`0 0 ${Math.max(pts.length, 2)} 40`}
        preserveAspectRatio="none"
        className="h-20 w-full"
        role="img"
        aria-label={summary}
      >
        {valued.map((p, i) => {
          const x = pts.findIndex((q) => q.dateISO === p.dateISO);
          const prev = i > 0 ? valued[i - 1] : null;
          const prevX = prev ? pts.findIndex((q) => q.dateISO === prev.dateISO) : null;
          // Only join ADJACENT valued days — a gap stays a gap.
          if (prevX == null || x - prevX !== 1) return null;
          const y1 = 40 - (((prev!.value as number) - min) / span) * 38 - 1;
          const y2 = 40 - (((p.value as number) - min) / span) * 38 - 1;
          return (
            <line
              key={p.dateISO} x1={prevX} y1={y1} x2={x} y2={y2}
              stroke={p.basis === "observed" ? "var(--accent-info)" : "var(--text-faint)"}
              strokeWidth={0.6} vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      <p className="sr-only">{summary}</p>
      {gaps > 0 && (
        <p className="text-[11px] text-faint">
          {gaps} day(s) in this range have no assertable value and are shown as gaps.
        </p>
      )}
    </section>
  );
}

function ScopeSummary({ scope }: { scope: NonNullable<ExplorationNode["scope"]> }) {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const lines: string[] = [];
  if (scope.heldUnavailable)    lines.push(`${plural(scope.heldUnavailable, "position", "positions")} held but could not be valued`);
  if (scope.notYetOwned)        lines.push(`${plural(scope.notYetOwned, "position was", "positions were")} acquired after this date`);
  if (scope.alreadyClosed)      lines.push(`${plural(scope.alreadyClosed, "position had", "positions had")} already been sold`);
  if (scope.ownershipUncertain) lines.push(`${plural(scope.ownershipUncertain, "position has", "positions have")} uncertain ownership`);
  if (scope.excludedArtifact)   lines.push(`${plural(scope.excludedArtifact, "position has", "positions have")} no ownership evidence`);
  if (lines.length === 0) return null;
  return (
    <details className="rounded-lg border border-hairline bg-[var(--surface-raised)] p-3">
      <summary className="cursor-pointer text-xs text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]">
        Not shown on this date ({lines.length})
      </summary>
      <ul className="mt-2 space-y-1 text-[11px] text-faint">
        {lines.map((l) => <li key={l}>{l}</li>)}
      </ul>
    </details>
  );
}

/** Coded reasons → sentences. Presentation only; the code is the source of truth. */
function humanReason(code: string): string {
  if (!code) return "";
  const map: Record<string, string> = {
    NO_SNAPSHOT_FOR_DATE: "no snapshot was recorded for this date",
    AGGREGATE_COMPONENT_UNASSERTABLE: "one of its components cannot be asserted on this date",
    REAL_ASSETS_HAVE_NO_STORED_COMPOSITION: "Fourth Meridian does not hold a per-account breakdown for this component",
    NO_ACCOUNT_LEVEL_FOR_THIS_BUCKET: "this component has no account-level breakdown",
    NO_ACCOUNTS_IN_BUCKET: "no accounts contributed to this component on this date",
    NO_HOLDING_LEVEL_FOR_THIS_ACCOUNT_TYPE: "this account type has no holdings",
    NO_HOLDINGS_IN_ACCOUNT: "no holdings were recorded for this account on this date",
    BEFORE_ACCOUNT_COVERAGE: "this date precedes the earliest evidence for the account",
    BELOW_PRICE_PROVIDER_FLOOR: "no price history reaches this date",
    QUANTITY_NOT_LICENSED: "the quantity cannot be carried back to this date",
    WALLET_LEDGER_INCOMPLETE: "the wallet's transaction ledger does not account for its balance",
    HELD_FLAT_NO_LEDGER: "no transaction ledger reaches this date",
    NO_HELD_POSITIONS: "no positions were held on this date",
    NOT_HELD: "not held on this date",
    NOT_YET_OWNED: "not yet owned on this date",
    HOLDING_IS_THE_DEEPEST_LEVEL: "",
    NOT_RESOLVED: "no value could be resolved for this date",
    OWNERSHIP_CLOSED: "the position had been closed by this date",
    NO_DEFENSIBLE_VALUE: "no defensible value could be resolved",
    ACCOUNTS_CONTRADICT_BUCKET_TOTAL: "the account values conflict with the recorded total",
    HOLDINGS_CONTRADICT_ACCOUNT_TOTAL: "the holding values conflict with the recorded total",
  };
  return map[code] ?? code.toLowerCase().replace(/_/g, " ");
}
