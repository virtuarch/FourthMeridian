"use client";

/**
 * components/platform/growth/BetaRequestReview.tsx  (PB-6)
 *
 * Growth & Revenue → Beta Access: review ANY request, record risk verdicts, and
 * choose between Deny and Deny and block.
 *
 *   BetaRequestReviewSection — mounted in a request's detail panel. Reads
 *     GET …/requests/[id]/risk-review (status, decision instant, verdict
 *     history, whether this request currently blocks its mailbox) and offers,
 *     to a GROWTH_REVENUE WRITE holder only:
 *       · PENDING — "Deny" (status only, does not block) and "Deny and block"
 *         (deny, then a SUSPICIOUS verdict — beta-request-review-model.ts);
 *       · DENIED  — "Block address" (SUSPICIOUS) or, when blocked, "Clear block"
 *         (LEGITIMATE / UNREVIEWED, reason required);
 *       · every status — Mark Legitimate / Suspicious / Unreviewed.
 *     Every one confirms in a dialog; every outcome — including a partial
 *     "denied but not blocked", which offers "Block now" — is stated in words.
 *   BetaRequestBrowser — the status view: Pending / Approved / Denied / Joined /
 *     All, a Suspicious filter, server paging (GET …/requests?view=…).
 *
 * UI-001 — a READ holder sees every state as text and one explanatory line,
 * never a button that 403s. The server gates decide regardless.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Ban, ChevronLeft, ChevronRight, ShieldAlert, ShieldCheck, ShieldOff, X } from "lucide-react";
import { RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { ToneBadge } from "@/components/platform/platform-surface";
import { UtcStamp, timeAgo } from "../widget-kit";
import { EMPTY_OPERATOR_REASON, OperatorReasonField, reasonPayload, type OperatorReasonValue } from "../widgets/OperatorReasonField";
import type { BetaRiskReviewHistoryResponse, BetaRiskReviewStatusValue } from "@/lib/platform/growth/beta-risk-types";
import {
  BETA_REQUEST_VIEWS, betaRequestListSearch,
  type BetaRequestListResponse, type BetaRequestListRow, type BetaRequestView,
} from "@/lib/platform/growth/beta-request-list-types";
import {
  DENY_AND_BLOCK_COPY, DENY_COPY, REQUESTS_URL, STATUS_LABEL, VERDICT_LABEL, VIEW_LABEL,
  blockStateText, plainDenyEffect, reviewActions, riskReviewUrl, runDeny, runDenyAndBlock, runVerdict, verdictEffect,
  type ReviewAction, type ReviewOutcome,
} from "./beta-request-review-model";

/** UI-001 — the line a READ holder sees where the review controls would be. */
export const REVIEW_READ_ONLY_LINE =
  "Read-only — recording a verdict, denying and blocking need WRITE access to Growth.";

const BTN = "inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 text-xs font-semibold disabled:opacity-40 lg:min-h-8";
const DANGER = { background: "rgba(248,113,113,.1)", color: "var(--danger-400, #f87171)", borderColor: "rgba(248,113,113,.28)" };
const NEUTRAL = { background: "var(--surface-inset)", color: "var(--text-primary)", borderColor: "var(--border-hairline)" };

const VERDICT_TONE: Record<BetaRiskReviewStatusValue, "ok" | "bad" | "muted"> = { LEGITIMATE: "ok", SUSPICIOUS: "bad", UNREVIEWED: "muted" };

/** The confirm a pending action opens (null = none). */
type Dialog =
  | { kind: "deny" }
  | { kind: "denyAndBlock" }
  | { kind: "verdict"; status: BetaRiskReviewStatusValue; title: string; confirmLabel: string }
  | { kind: "clearBlock" };

function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-[var(--text-secondary)]">{label}</span>
      <span className="min-w-0 text-right text-[var(--text-primary)]">{children}</span>
    </div>
  );
}

function OutcomeLine({ outcome }: { outcome: ReviewOutcome }) {
  const color = outcome.tone === "success" ? "var(--accent-positive)" : outcome.tone === "warning" ? "var(--accent-warning)" : "var(--accent-negative)";
  return <p role={outcome.tone === "success" ? "status" : "alert"} className="text-[11px] leading-snug" style={{ color }} data-review-outcome={outcome.tone}>{outcome.message}</p>;
}

export function BetaRequestReviewSection({ requestId, canWrite, onChanged }: {
  requestId: string;
  canWrite: boolean;
  /** Called after any action committed (fully or in part), so the host refetches its lists. */
  onChanged?: () => void | Promise<void>;
}) {
  const [hist, setHist] = useState<BetaRiskReviewHistoryResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [reason, setReason] = useState<OperatorReasonValue>(EMPTY_OPERATOR_REASON);
  const [clearTo, setClearTo] = useState<"LEGITIMATE" | "UNREVIEWED">("LEGITIMATE");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await fetch(riskReviewUrl(requestId), { credentials: "same-origin" });
      if (!r.ok) throw new Error(r.status === 403 ? "Not authorized" : r.status === 404 ? "Request not found (it may have been deleted)." : `Could not load the review (${r.status})`);
      setHist((await r.json()) as BetaRiskReviewHistoryResponse);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load the review");
    }
  }, [requestId]);

  // Hosts mount this with `key={requestId}`, so a different request starts from a clean state.
  useEffect(() => {
    let alive = true;
    (async () => { if (alive) await load(); })();
    return () => { alive = false; };
  }, [load]);

  const close = () => { setDialog(null); setReason(EMPTY_OPERATOR_REASON); setClearTo("LEGITIMATE"); };

  /** Run one action, state its outcome, re-read the history, tell the host. */
  async function act(fn: () => Promise<ReviewOutcome>) {
    setBusy(true);
    try {
      const o = await fn();
      setOutcome(o);
      close();
      await load();
      await onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  if (!hist) {
    return loadError
      ? <p role="alert" className="border-t border-[var(--border-hairline)] pt-3 text-[11px] text-[var(--accent-negative)]">{loadError}</p>
      : <p className="border-t border-[var(--border-hairline)] pt-3 text-[11px] text-[var(--text-muted)]">Loading review…</p>;
  }

  const status = hist.request.status;
  const latest = hist.reviews[0] ?? null;
  const actions = reviewActions(canWrite, status, hist.block);
  const chosen = reasonPayload(reason);
  const has = (a: ReviewAction) => actions.includes(a);
  // "Denied but not blocked" — Block now finishes the job (the same SUSPICIOUS verdict).
  const blockNowOffered = outcome?.offerBlockNow === true && status === "DENIED";

  const openVerdict = (s: BetaRiskReviewStatusValue) => {
    setOutcome(null);
    setDialog({ kind: "verdict", status: s, title: `Mark this request ${VERDICT_LABEL[s]}?`, confirmLabel: `Mark ${VERDICT_LABEL[s]}` });
  };

  const confirm = () => {
    if (!dialog) return;
    if (dialog.kind === "deny") return act(() => runDeny(requestId));
    if (!chosen) return;
    const note = chosen.note ?? null;
    if (dialog.kind === "denyAndBlock") return act(() => runDenyAndBlock(requestId, chosen, note));
    if (dialog.kind === "clearBlock") return act(() => runVerdict(requestId, clearTo, chosen, note, { requestStatus: status }));
    return act(() => runVerdict(requestId, dialog.status, chosen, note, { requestStatus: status }));
  };

  return (
    <section className="flex flex-col gap-2 border-t border-[var(--border-hairline)] pt-3" aria-label="Review" data-beta-review>
      <KV label="Status">{STATUS_LABEL[status]}</KV>
      <KV label="Decided">
        {hist.request.decidedAt ? <span className="flex flex-col items-end">{`${timeAgo(hist.request.decidedAt)} ago`}<UtcStamp iso={hist.request.decidedAt} label="at" /></span> : "—"}
      </KV>
      <KV label="Verdict">
        {latest ? <ToneBadge word={VERDICT_LABEL[latest.status]} tone={VERDICT_TONE[latest.status]} /> : "None recorded"}
      </KV>
      <KV label="Address">
        <span data-block-state={hist.block.state}>{blockStateText(hist.block, hist.blocklist)}</span>
      </KV>

      {outcome && <OutcomeLine outcome={outcome} />}
      {canWrite && blockNowOffered && (
        <button type="button" data-block-now disabled={busy}
          onClick={() => setDialog({ kind: "verdict", status: "SUSPICIOUS", title: "Block this address now?", confirmLabel: "Block now" })}
          className={`${BTN} w-fit`} style={DANGER}>
          <Ban size={13} aria-hidden /> Block now
        </button>
      )}

      {canWrite && (
        <div className="flex flex-col gap-2 pt-1" data-review-actions>
          {has("deny") && (
            <div className="flex flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-2.5">
              <div className="flex flex-wrap gap-2">
                <button type="button" data-deny disabled={busy} onClick={() => { setOutcome(null); setDialog({ kind: "deny" }); }} className={BTN} style={DANGER}>
                  <X size={13} aria-hidden /> Deny
                </button>
                <button type="button" data-deny-and-block disabled={busy} onClick={() => { setOutcome(null); setDialog({ kind: "denyAndBlock" }); }} className={BTN} style={DANGER}>
                  <Ban size={13} aria-hidden /> Deny and block
                </button>
              </div>
              <p className="text-[11px] leading-snug text-[var(--text-muted)]">{latest?.status === "SUSPICIOUS" ? plainDenyEffect(latest.status) : DENY_COPY}</p>
              <p className="text-[11px] leading-snug text-[var(--text-muted)]">{DENY_AND_BLOCK_COPY}</p>
            </div>
          )}
          {has("blockAddress") && (
            <button type="button" data-block-address disabled={busy}
              onClick={() => { setOutcome(null); setDialog({ kind: "verdict", status: "SUSPICIOUS", title: "Block this address?", confirmLabel: "Block address" }); }}
              className={`${BTN} w-fit`} style={DANGER}>
              <Ban size={13} aria-hidden /> Block address
            </button>
          )}
          {has("clearBlock") && (
            <button type="button" data-clear-block disabled={busy} onClick={() => { setOutcome(null); setDialog({ kind: "clearBlock" }); }} className={`${BTN} w-fit`} style={NEUTRAL}>
              <ShieldOff size={13} aria-hidden /> Clear block
            </button>
          )}
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Record a verdict">
            <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Verdict</span>
            {has("markLegitimate") && (
              <button type="button" data-mark="LEGITIMATE" disabled={busy} onClick={() => openVerdict("LEGITIMATE")} className={BTN} style={NEUTRAL}>
                <ShieldCheck size={13} aria-hidden /> Legitimate
              </button>
            )}
            {has("markSuspicious") && (
              <button type="button" data-mark="SUSPICIOUS" disabled={busy} onClick={() => openVerdict("SUSPICIOUS")} className={BTN} style={NEUTRAL}>
                <ShieldAlert size={13} aria-hidden /> Suspicious
              </button>
            )}
            {has("markUnreviewed") && (
              <button type="button" data-mark="UNREVIEWED" disabled={busy} onClick={() => openVerdict("UNREVIEWED")} className={BTN} style={NEUTRAL}>
                Unreviewed
              </button>
            )}
          </div>
        </div>
      )}
      {!canWrite && <p className="text-[11px] leading-snug text-[var(--text-muted)]" data-read-only-line>{REVIEW_READ_ONLY_LINE}</p>}

      {/* Verdict history, newest first (append-only — the latest row is the current state). */}
      <div className="flex flex-col gap-1.5 border-t border-[var(--border-hairline)] pt-3" data-review-history>
        <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Verdict history</span>
        {hist.reviews.length === 0 ? (
          <span className="text-[11px] text-[var(--text-muted)]">No verdict recorded.</span>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {hist.reviews.map((r) => (
              <li key={r.id} className="flex flex-col gap-0.5 text-[11px]">
                <span className="flex flex-wrap items-center gap-x-2">
                  <ToneBadge word={VERDICT_LABEL[r.status]} tone={VERDICT_TONE[r.status]} />
                  <span className="text-[var(--text-muted)]">{r.reasonCode}</span>
                  <span className="text-[var(--text-muted)]">{`${timeAgo(r.at)} ago${r.by ? ` · ${r.by}` : ""}`}</span>
                </span>
                {r.note && <span className="leading-snug text-[var(--text-primary)]">{r.note}</span>}
              </li>
            ))}
          </ul>
        )}
        {hist.capped && <span className="text-[10px] text-[var(--text-faint)]">Older verdicts are not shown.</span>}
      </div>

      {canWrite && (<>
      {dialog?.kind === "deny" && (
        <ConfirmDialog icon={X} title="Deny this request?"
          message={<>{plainDenyEffect(latest?.status)} No email is sent.</>}
          confirmLabel="Deny" busy={busy} onConfirm={confirm} onClose={close} />
      )}
      {dialog?.kind === "denyAndBlock" && (
        <ConfirmDialog icon={Ban} title="Deny and block this address?"
          message={<>Denies the request, then marks it Suspicious: future requests from this address are silently dropped, and the denial is final
            for every invitation path until the block is cleared. No email is sent.
            <OperatorReasonField value={reason} onChange={setReason} disabled={busy} label="A reason is recorded with the verdict" /></>}
          confirmLabel="Deny and block" busy={busy} confirmDisabled={chosen === null} onConfirm={confirm} onClose={close} />
      )}
      {dialog?.kind === "verdict" && (
        <ConfirmDialog icon={dialog.status === "SUSPICIOUS" ? ShieldAlert : ShieldCheck} title={dialog.title}
          message={<>{verdictEffect(dialog.status, status, hist.block)}
            <OperatorReasonField value={reason} onChange={setReason} disabled={busy} label="A reason is recorded with the verdict" /></>}
          confirmLabel={dialog.confirmLabel} confirmTone={dialog.status === "SUSPICIOUS" ? "danger" : "meridian"}
          busy={busy} confirmDisabled={chosen === null} onConfirm={confirm} onClose={close} />
      )}
      {dialog?.kind === "clearBlock" && (
        <ConfirmDialog icon={ShieldOff} title={hist.block.state === "UNKNOWN" ? "Clear any block this request caused?" : "Clear this block?"}
          message={<>{verdictEffect(clearTo, status, hist.block)} The request stays denied.
            <span className="mt-3 flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Clear as">
              {(["LEGITIMATE", "UNREVIEWED"] as const).map((s) => (
                <label key={s} className="inline-flex min-h-11 items-center gap-1.5 text-xs lg:min-h-8">
                  <input type="radio" name={`clear-${requestId}`} checked={clearTo === s} onChange={() => setClearTo(s)} disabled={busy} />
                  {`Mark ${VERDICT_LABEL[s]}`}
                </label>
              ))}
            </span>
            <OperatorReasonField value={reason} onChange={setReason} disabled={busy} label="A reason is recorded with the verdict" /></>}
          confirmLabel="Clear block" confirmTone="meridian" busy={busy} confirmDisabled={chosen === null} onConfirm={confirm} onClose={close} />
      )}
      </>)}
    </section>
  );
}

// ── The status view ───────────────────────────────────────────────────────────

export function BetaRequestBrowser({ canWrite, onChanged }: { canWrite: boolean; onChanged?: () => void | Promise<void> }) {
  const [view, setView] = useState<BetaRequestView>("DENIED");
  const [suspicious, setSuspicious] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<BetaRequestListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<BetaRequestListRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = betaRequestListSearch({ view, verdict: suspicious ? "SUSPICIOUS" : null, page });
      const r = await fetch(`${REQUESTS_URL}?${qs}`, { credentials: "same-origin" });
      if (!r.ok) throw new Error(r.status === 403 ? "Not authorized" : `Request failed (${r.status})`);
      setData((await r.json()) as BetaRequestListResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [view, suspicious, page]);

  useEffect(() => {
    let alive = true;
    (async () => { if (alive) await load(); })();
    return () => { alive = false; };
  }, [load]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const from = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = data ? Math.min(data.total, data.page * data.pageSize) : 0;

  return (
    <div className="flex min-w-0 flex-col gap-2" data-beta-browser>
      <div className="flex flex-wrap items-center gap-2">
        <span role="tablist" aria-label="Requests by status" className="inline-flex flex-wrap items-center rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-0.5">
          {BETA_REQUEST_VIEWS.map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => { setView(v); setPage(1); }}
              className={`min-h-11 rounded-[var(--radius-xs)] px-2.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-7 ${
                view === v ? "bg-[var(--surface-raised,rgba(255,255,255,.06))] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"}`}>
              {VIEW_LABEL[v]}
            </button>
          ))}
        </span>
        <button type="button" aria-pressed={suspicious} data-filter-suspicious onClick={() => { setSuspicious((s) => !s); setPage(1); }}
          className="inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] px-2.5 text-[11px] font-medium lg:min-h-7"
          style={suspicious ? { background: "rgba(248,113,113,.1)", color: "var(--danger-400, #f87171)" } : { color: "var(--text-secondary)" }}>
          <ShieldAlert size={12} aria-hidden /> Suspicious only
        </button>
      </div>

      {error && <p role="alert" className="text-[11px] text-[var(--accent-negative)]">{error}</p>}
      {data?.notes?.map((n) => <p key={n} className="text-[11px] text-[var(--text-muted)]">{n}</p>)}

      {loading && !data ? (
        <p className="py-4 text-xs text-[var(--text-muted)]">Loading…</p>
      ) : !data || data.rows.length === 0 ? (
        <p className="py-4 text-xs text-[var(--text-secondary)]">{suspicious ? "No request in this view is marked Suspicious." : "No requests in this view."}</p>
      ) : (
        <ul className="-mx-1 divide-y divide-[var(--border-hairline)]" aria-label={`${VIEW_LABEL[view]} beta requests`}>
          {data.rows.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => setSelected(r)} aria-haspopup="dialog"
                className="flex min-h-11 w-full items-center justify-between gap-2 px-1 py-2 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)]">
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-[var(--text-primary)]">{r.email}</span>
                  <span className="block truncate text-[10px] text-[var(--text-muted)]">
                    {`${STATUS_LABEL[r.status]} · requested ${timeAgo(r.createdAt)} ago${r.decidedAt ? ` · decided ${timeAgo(r.decidedAt)} ago` : ""}`}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {r.review && <ToneBadge word={VERDICT_LABEL[r.review.status]} tone={VERDICT_TONE[r.review.status]} />}
                  {r.block.state === "BLOCKED" && <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--accent-negative)]" data-row-blocked>Blocked</span>}
                  {r.block.state === "UNKNOWN" && <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]" title="Block status is unavailable right now." data-row-block-unknown>Block ?</span>}
                  <ChevronRight size={12} aria-hidden className="text-[var(--text-faint)]" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {data && data.total > 0 && (
        <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums text-[var(--text-muted)]" data-beta-pager>
          <span>{`${from}–${to} of ${data.total}`}</span>
          <span className="flex items-center gap-1">
            <button type="button" aria-label="Previous page" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-xs)] disabled:opacity-40 lg:min-h-8 lg:min-w-8"><ChevronLeft size={14} aria-hidden /></button>
            <span>{`${page} / ${pages}`}</span>
            <button type="button" aria-label="Next page" disabled={page >= pages || loading} onClick={() => setPage((p) => Math.min(pages, p + 1))}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-xs)] disabled:opacity-40 lg:min-h-8 lg:min-w-8"><ChevronRight size={14} aria-hidden /></button>
          </span>
        </div>
      )}

      <RightPanel open={selected != null} onClose={() => setSelected(null)} ariaLabel="Beta request review">
        {selected && (
          <>
            <PanelHeader eyebrow="Beta request" title={selected.email} />
            <PanelContent>
              <div className="flex flex-col gap-3 text-xs">
                <KV label="Requested">{`${timeAgo(selected.createdAt)} ago`}</KV>
                {selected.redeemedAt && <KV label="Joined">{`${timeAgo(selected.redeemedAt)} ago`}</KV>}
                {selected.note && (
                  <div className="flex flex-col gap-1 border-t border-[var(--border-hairline)] pt-3">
                    <span className="text-[var(--text-secondary)]">Note</span>
                    <span className="leading-snug text-[var(--text-primary)]">{selected.note}</span>
                  </div>
                )}
                <BetaRequestReviewSection requestId={selected.id} canWrite={canWrite}
                  onChanged={async () => { await load(); await onChanged?.(); }} key={selected.id} />
              </div>
            </PanelContent>
          </>
        )}
      </RightPanel>
    </div>
  );
}

