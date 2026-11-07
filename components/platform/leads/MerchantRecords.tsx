"use client";

/**
 * components/platform/leads/MerchantRecords.tsx  (PB-9 — Merchant Identity KPIs drill into their records)
 *
 * The records behind each Merchant Identity KPI, opened from the KPI tile:
 * Merchants (directory → merchant detail), Without a merchant (transactions,
 * split by identity class), Merged and Dismissed (audited decisions in the
 * selected window). One read route — GET /api/platform/merchant-ops/records,
 * MERCHANT_OPS READ — whose total is the KPI's own count; the merchant detail
 * reads GET /api/platform/merchant-ops/merchants/[id].
 *
 * READ-ONLY inspection. The one control, "Reconsider" on a dismissed pair, is
 * rendered only for a WRITE holder (access.canWrite — descriptive; the route
 * re-checks a FRESH MERCHANT_OPS WRITE and the required reason). Merge and
 * dismiss stay on the review page. All state lives in the URL
 * (merchant-records-url.ts), written by the parent with REPLACE intent.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, RotateCcw, Search, X } from "lucide-react";
import { Block, Surface } from "@/components/atlas/Surface";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { GlassButton } from "@/components/atlas/GlassButton";
import { EMPTY_OPERATOR_REASON, OperatorReasonField, reasonPayload, type OperatorReasonValue } from "@/components/platform/widgets/OperatorReasonField";
import {
  IDENTITY_CLASS_META, MERCHANT_RECORDS_SORTS, PROVIDER_LABEL, SORT_LABEL,
  type IdentityClass, type MergeDecisionRow, type MerchantDetailResponse, type MerchantDirectoryRow, type MerchantRecordsKind,
  type MerchantRecordsPage, type MerchantRecordsResponse, type UnlinkedTransactionRow,
} from "@/lib/platform/merchant/records-types";
import { ChartMessage, Segmented } from "./visual-kit";
import { recordsApiPath, type MerchantRecordsUrlState } from "./merchant-records-url";

const n = (v: number) => v.toLocaleString("en-US");
const FIELD = "min-h-11 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] bg-transparent px-2 text-xs text-[var(--text-secondary)] lg:min-h-8";
const LINK = "inline-flex min-h-11 items-center gap-1 text-xs font-medium text-[var(--text-primary)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-7";

export const RECORDS_TITLE: Readonly<Record<MerchantRecordsKind, string>> = {
  merchants: "Merchants",
  unlinked: "Without a merchant",
  merged: "Merged",
  dismissed: "Dismissed",
};

const REVIEW_STATUS: Readonly<Record<MerchantDirectoryRow["reviewStatus"], string>> = {
  MERGE_SURVIVOR: "Merge survivor",
  KEPT_APART: "Kept apart",
  NONE: "Not reviewed",
};

export const RECONSIDER_READ_ONLY =
  "Read-only access. Reconsidering a dismissed pair requires a Merchant Operations WRITE grant.";

/** "Showing 26–50 of 8,014" — the one population line, from the server's own counts. */
export function populationLine(p: Pick<MerchantRecordsPage<unknown>, "total" | "page" | "pageSize" | "rows">): string {
  if (p.total === 0) return "No matching records";
  const from = (p.page - 1) * p.pageSize + 1;
  return `Showing ${n(from)}–${n(from + p.rows.length - 1)} of ${n(p.total)}`;
}

/** GET a JSON path; state is set only from the request's own callbacks (keyed, so a stale answer never lands). */
function useJson<T>(path: string | null, reload: number): { data: T | null; loading: boolean; error: string | null } {
  const key = path ? `${path}#${reload}` : null;
  const [res, setRes] = useState<{ key: string | null; data: T | null; error: string | null }>({ key: null, data: null, error: null });
  useEffect(() => {
    if (!key || !path) return;
    let alive = true;
    fetch(path, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 403 ? "Not authorized" : r.status === 404 ? "Not found" : `Request failed (${r.status})`);
        return (await r.json()) as T;
      })
      .then((data) => { if (alive) setRes({ key, data, error: null }); })
      .catch((e: unknown) => { if (alive) setRes({ key, data: null, error: e instanceof Error ? e.message : "Failed to load" }); });
    return () => { alive = false; };
  }, [key, path]);
  if (!key) return { data: null, loading: false, error: null };
  const fresh = res.key === key;
  // While a new page loads, the previous page stays on screen (no flash to empty).
  return { data: res.data, loading: !fresh, error: fresh ? res.error : null };
}

export interface MerchantRecordsProps {
  state: MerchantRecordsUrlState & { records: MerchantRecordsKind };
  onState: (next: MerchantRecordsUrlState) => void;
  canWrite: boolean;
}

export function MerchantRecords({ state, onState, canWrite }: MerchantRecordsProps) {
  const [reload, setReload] = useState(0);
  const path = state.merchantId ? null : recordsApiPath(state);
  const f = useJson<MerchantRecordsResponse>(path, reload);
  const set = (patch: Partial<MerchantRecordsUrlState>) => onState({ ...state, ...patch });
  const close = () => onState({ ...state, records: null, q: null, sort: null, page: 1, filter: null, merchantId: null });

  return (
    <Block label={`Records · ${RECORDS_TITLE[state.records]}`} className="min-w-0"
      action={<button type="button" onClick={close} className={LINK} data-records-close><X size={12} aria-hidden /> Close</button>}>
      <Surface className="flex min-w-0 flex-col gap-3 p-4 sm:p-5" >
        <div data-merchant-records={state.records} className="flex min-w-0 flex-col gap-3">
          <Segmented label="Records" value={state.records}
            onChange={(k) => onState({ ...state, records: k, q: null, sort: null, page: 1, filter: null, merchantId: null })}
            options={(Object.keys(RECORDS_TITLE) as MerchantRecordsKind[]).map((k) => ({ id: k, label: RECORDS_TITLE[k] }))} />
          {state.merchantId ? (
            <MerchantDetail id={state.merchantId} onBack={() => set({ merchantId: null })} />
          ) : (
            <>
              <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => {
                e.preventDefault();
                const v = String(new FormData(e.currentTarget).get("rq") ?? "").trim();
                set({ q: v || null, page: 1 });
              }}>
                <label className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] px-2.5 sm:max-w-xs lg:min-h-8">
                  <Search size={12} aria-hidden className="shrink-0 text-[var(--text-faint)]" />
                  {/* Uncontrolled, keyed on the URL's query: Back/Forward or a tab switch resets it without an effect. */}
                  <input key={`${state.records}:${state.q ?? ""}`} name="rq" type="search" defaultValue={state.q ?? ""} maxLength={40}
                    placeholder={state.records === "merchants" ? "Search name, key or id" : state.records === "unlinked" ? "Search descriptor (identity expected)" : "Search merchant key"}
                    aria-label={`Search ${RECORDS_TITLE[state.records]}`}
                    className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none" />
                </label>
                <button type="submit" className={`${FIELD} font-semibold`}>Search</button>
                <select aria-label="Sort" value={state.sort ?? MERCHANT_RECORDS_SORTS[state.records][0]} className={FIELD}
                  onChange={(e) => set({ sort: e.target.value === MERCHANT_RECORDS_SORTS[state.records][0] ? null : e.target.value, page: 1 })}>
                  {MERCHANT_RECORDS_SORTS[state.records].map((s) => <option key={s} value={s}>{SORT_LABEL[s] ?? s}</option>)}
                </select>
                {state.records === "unlinked" && (
                  <select aria-label="Identity class" value={state.filter ?? ""} className={FIELD} data-class-filter
                    onChange={(e) => set({ filter: (e.target.value || null) as IdentityClass | null, page: 1 })}>
                    <option value="">{`All without a merchant${f.data?.byClass ? ` (${n(f.data.kpiTotal)})` : ""}`}</option>
                    {(f.data?.byClass ?? []).map((c) => <option key={c.key} value={c.key}>{`${c.label}${c.expected ? " — actionable" : " — excluded"} (${n(c.count)})`}</option>)}
                  </select>
                )}
              </form>
              {f.loading && !f.data && <ChartMessage>Reading records…</ChartMessage>}
              {f.error && <ChartMessage>{`Records unavailable — ${f.error}`}</ChartMessage>}
              {f.data && (
                <>
                  <p className="text-[11px] tabular-nums text-[var(--text-muted)]" data-records-population>
                    {populationLine(f.data)}
                    {(f.data.total !== f.data.kpiTotal) && ` · ${n(f.data.kpiTotal)} in the KPI`}
                    {f.data.since && ` · since ${f.data.since.slice(0, 10)} (${state.period} d)`}
                  </p>
                  {state.records === "unlinked" && f.data.byClass && <ClassSummary byClass={f.data.byClass} />}
                  <RecordsBody data={f.data} canWrite={canWrite} onOpenMerchant={(id) => set({ merchantId: id })} onChanged={() => setReload((x) => x + 1)} />
                  <Pager page={f.data.page} pageCount={f.data.pageCount} onPage={(p) => set({ page: p })} />
                </>
              )}
            </>
          )}
        </div>
      </Surface>
    </Block>
  );
}

function ClassSummary({ byClass }: { byClass: NonNullable<MerchantRecordsPage<unknown>["byClass"]> }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-secondary)]" aria-label="Without a merchant, by identity class" data-class-summary>
      {byClass.map((c) => (
        <li key={c.key} title={IDENTITY_CLASS_META[c.key].reason}>
          <span className="tabular-nums text-[var(--text-primary)]">{n(c.count)}</span> {c.label}
          <span className="text-[var(--text-faint)]">{c.expected ? " · actionable" : " · not a defect"}</span>
        </li>
      ))}
    </ul>
  );
}

function Pager({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (p: number) => void }) {
  if (pageCount <= 1) return null;
  return (
    <nav aria-label="Pages" className="flex items-center justify-end gap-2 text-[11px] text-[var(--text-muted)]" data-pager>
      <button type="button" className={FIELD} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft size={12} aria-hidden /></button>
      <span className="tabular-nums">{`Page ${n(page)} of ${n(pageCount)}`}</span>
      <button type="button" className={FIELD} disabled={page >= pageCount} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight size={12} aria-hidden /></button>
    </nav>
  );
}

function Table({ label, head, children }: { label: string; head: string[]; children: ReactNode }) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full min-w-[560px] text-xs" aria-label={label}>
        <thead><tr className="border-b border-[var(--border-hairline)] text-[10px] uppercase tracking-wide text-[var(--text-faint)]">
          {head.map((h) => <th key={h} scope="col" className="px-2 py-1.5 text-left font-medium">{h}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-[var(--border-hairline)]">{children}</tbody>
      </table>
    </div>
  );
}
const TD = "px-2 py-2 align-top text-[var(--text-secondary)]";

export function RecordsBody({ data, canWrite, onOpenMerchant, onChanged }: { data: MerchantRecordsResponse; canWrite: boolean; onOpenMerchant: (id: string) => void; onChanged: () => void }) {
  if (data.rows.length === 0) return <ChartMessage>{data.kpiTotal === 0 ? "Nothing to show for this figure." : "No records match."}</ChartMessage>;
  if (data.kind === "merchants") {
    const rows = data.rows as MerchantDirectoryRow[];
    return (
      <Table label="Merchant directory" head={["Merchant", "Aliases", "Transactions", "Last seen", "Status"]}>
        {rows.map((r) => (
          <tr key={r.id} data-merchant-row={r.id}>
            <td className={TD}>
              <button type="button" onClick={() => onOpenMerchant(r.id)} className={`${LINK} text-left`}>{r.displayName}</button>
              <span className="block truncate font-mono text-[10px] text-[var(--text-faint)]">{r.id}</span>
            </td>
            <td className={`${TD} tabular-nums`}>{n(r.aliasCount)}</td>
            <td className={`${TD} tabular-nums`}>{n(r.transactionCount)}</td>
            <td className={`${TD} tabular-nums`}>{r.lastSeen ?? "—"}</td>
            <td className={TD}>{[REVIEW_STATUS[r.reviewStatus], r.providerBacked ? "provider id" : "name-derived", r.enriched ? "enriched" : null].filter(Boolean).join(" · ")}</td>
          </tr>
        ))}
      </Table>
    );
  }
  if (data.kind === "unlinked") {
    const rows = data.rows as UnlinkedTransactionRow[];
    return (
      <Table label="Transactions without a merchant" head={["Date", "Descriptor", "Provider", "Type", "Why no merchant", "Expected"]}>
        {rows.map((r) => (
          <tr key={r.id} data-unlinked-row={r.identityClass}>
            <td className={`${TD} tabular-nums`}>{r.date}</td>
            <td className={TD}>{r.descriptor ?? <span className="text-[var(--text-faint)]">withheld</span>}</td>
            <td className={TD}>{PROVIDER_LABEL[r.provider]}</td>
            <td className={TD}>{`${r.flowType ?? "unclassified"} · ${r.category}`}</td>
            <td className={TD} title={IDENTITY_CLASS_META[r.identityClass].reason}>{IDENTITY_CLASS_META[r.identityClass].label}</td>
            <td className={TD}>{r.expected ? <span className="text-[var(--accent-warning)]">Yes — actionable</span> : "No — excluded"}</td>
          </tr>
        ))}
      </Table>
    );
  }
  return <DecisionRows rows={data.rows as MergeDecisionRow[]} kind={data.kind} canWrite={canWrite} onOpenMerchant={onOpenMerchant} onChanged={onChanged} />;
}

function DecisionRows({ rows, kind, canWrite, onOpenMerchant, onChanged }: { rows: MergeDecisionRow[]; kind: MerchantRecordsKind; canWrite: boolean; onOpenMerchant: (id: string) => void; onChanged: () => void }) {
  const [pending, setPending] = useState<MergeDecisionRow | null>(null);
  const [reason, setReason] = useState<OperatorReasonValue>(EMPTY_OPERATOR_REASON);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const chosen = reasonPayload(reason);
  const merged = kind === "merged";

  const reconsider = useCallback(async () => {
    if (!pending || chosen === null) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/merchant-ops/reconsider", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairKey: pending.pairKey, reason: chosen }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Request failed (${res.status})`);
      setOutcome(`Reconsidered "${pending.sourceKey}" / "${pending.destinationKey}". The detector may propose the pair again on the review page.`);
      setPending(null);
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : "Reconsider failed"); }
    finally { setBusy(false); }
  }, [pending, chosen, onChanged]);

  return (
    <>
      {outcome && <p role="status" className="text-[11px] text-[var(--text-secondary)]">{outcome}</p>}
      {!merged && !canWrite && <p className="text-[11px] text-[var(--text-muted)]" data-read-only>{RECONSIDER_READ_ONLY}</p>}
      <Table label={merged ? "Merge history" : "Dismissed candidates"}
        head={merged ? ["Decided", "Source → destination", "Transactions moved", "Evidence", "Operator · reason"] : ["Decided", "Candidate pair", "Evidence", "Operator · reason", ...(canWrite ? [""] : [])]}>
        {rows.map((r) => (
          <tr key={r.id} data-decision-row={r.verdict}>
            <td className={`${TD} tabular-nums`}>{r.decidedAt.slice(0, 16).replace("T", " ")} UTC</td>
            <td className={TD}>
              <span className="block">{merged ? `${r.sourceKey} → ` : `${r.sourceKey} / `}
                {r.destinationMerchantId
                  ? <button type="button" onClick={() => onOpenMerchant(r.destinationMerchantId as string)} className={LINK}>{r.destinationKey}</button>
                  : r.destinationKey}
              </span>
            </td>
            {merged && <td className={`${TD} tabular-nums`}>{r.affectedTransactions === null ? "—" : n(r.affectedTransactions)}</td>}
            <td className={TD}>{r.evidenceTier}{r.evidenceSignal ? <span className="block text-[10px] text-[var(--text-faint)]">{r.evidenceSignal}</span> : null}</td>
            <td className={TD}>{r.operator ?? "—"}{r.reason ? <span className="block text-[10px] text-[var(--text-faint)]">{r.reason.code}{r.reason.note ? ` — ${r.reason.note}` : ""}</span> : null}</td>
            {!merged && canWrite && (
              <td className={TD}>
                <GlassButton tone="neutral" size="sm" aria-haspopup="dialog" data-reconsider
                  onClick={() => { setPending(r); setReason(EMPTY_OPERATOR_REASON); setError(null); setOutcome(null); }}>
                  <RotateCcw size={12} aria-hidden /> Reconsider
                </GlassButton>
              </td>
            )}
          </tr>
        ))}
      </Table>
      {pending && (
        <ConfirmDialog icon={RotateCcw} title={`Reconsider "${pending.sourceKey}" / "${pending.destinationKey}"?`}
          message={<>
            <p>The dismissal is removed and recorded in the audit log with your reason and a snapshot of the decision. No merchant is changed. The pair returns to the merge review only if the detector still proposes it.</p>
            {error && <p role="alert" className="mt-2 text-xs text-[var(--accent-negative)]">{error}</p>}
            <OperatorReasonField value={reason} onChange={setReason} disabled={busy} label="Reason (required) — recorded with this decision" />
          </>}
          confirmLabel="Reconsider" confirmTone="meridian" busy={busy} confirmDisabled={chosen === null}
          onConfirm={reconsider} onClose={() => { if (!busy) setPending(null); }} />
      )}
    </>
  );
}

function Counts({ label, rows }: { label: string; rows: { key: string; count: number }[] }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">{label}</p>
      {rows.length === 0 ? <p className="text-xs text-[var(--text-muted)]">—</p> : (
        <ul className="text-xs text-[var(--text-secondary)]">{rows.slice(0, 6).map((r) => <li key={r.key}><span className="tabular-nums text-[var(--text-primary)]">{n(r.count)}</span> {r.key}</li>)}</ul>
      )}
    </div>
  );
}

function MerchantDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const f = useJson<MerchantDetailResponse>(`/api/platform/merchant-ops/merchants/${encodeURIComponent(id)}`, 0);
  return (
    <div className="flex min-w-0 flex-col gap-4" data-merchant-detail={id}>
      <button type="button" onClick={onBack} className={`${LINK} self-start`}><ChevronLeft size={12} aria-hidden /> Back to the directory</button>
      {f.loading && <ChartMessage>Reading merchant…</ChartMessage>}
      {f.error && <ChartMessage>{`Merchant unavailable — ${f.error}`}</ChartMessage>}
      {f.data && (() => {
        const d = f.data;
        const m = d.merchant;
        return (
          <>
            <div>
              <p className="text-sm font-semibold text-[var(--text-primary)]">{m.displayName}</p>
              <p className="font-mono text-[10px] text-[var(--text-faint)]">{`${m.id} · ${m.canonicalKey}`}</p>
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                {`${n(m.transactionCount)} live transactions · ${n(m.aliasCount)} aliases · ${n(m.userRuleCount)} customer rules · last seen ${m.lastSeen ?? "—"} · ${REVIEW_STATUS[m.reviewStatus]} · ${m.providerBacked ? "provider entity id" : "name-derived"}${m.defaultCategory ? ` · default ${m.defaultCategory}` : ""}`}
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-3" data-classification>
              <Counts label="Category" rows={d.classification.byCategory} />
              <Counts label="Category source" rows={d.classification.byCategorySource} />
              <Counts label="Flow type" rows={d.classification.byFlowType} />
            </div>
            <Table label="Aliases" head={["Alias", "Source", "Added"]}>
              {d.aliases.rows.map((a) => <tr key={a.id}><td className={TD}>{a.alias}</td><td className={TD}>{a.source}</td><td className={`${TD} tabular-nums`}>{a.createdAt.slice(0, 10)}</td></tr>)}
            </Table>
            {d.aliases.total > d.aliases.rows.length && <p className="text-[11px] text-[var(--text-muted)]">{`First ${d.aliases.rows.length} of ${n(d.aliases.total)} aliases`}</p>}
            <Table label="Related transactions" head={["Date", "Provider", "Type", "Account type"]}>
              {d.transactions.rows.map((t) => <tr key={t.id}><td className={`${TD} tabular-nums`}>{t.date}</td><td className={TD}>{PROVIDER_LABEL[t.provider]}</td><td className={TD}>{`${t.flowType ?? "unclassified"} · ${t.category}`}</td><td className={TD}>{t.accountType}</td></tr>)}
            </Table>
            <p className="text-[11px] text-[var(--text-muted)]">{`Latest ${d.transactions.rows.length} of ${n(d.transactions.total)} live transactions · no amounts or customer detail on this surface`}</p>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">Identity history</p>
              <ol className="mt-1 flex flex-col gap-1 text-xs text-[var(--text-secondary)]" data-identity-history>
                {d.history.map((h, i) => <li key={`${h.at}-${i}`}><span className="tabular-nums text-[var(--text-muted)]">{h.at.slice(0, 10)}</span> {h.text}{h.operator ? ` · ${h.operator}` : ""}</li>)}
              </ol>
            </div>
          </>
        );
      })()}
    </div>
  );
}
