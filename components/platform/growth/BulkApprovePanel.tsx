"use client";

/**
 * components/platform/growth/BulkApprovePanel.tsx  (PR C · bulk beta approval)
 *
 * The inline bulk bar of Growth's Waiting list, in three steps:
 *
 *   1. BAR      "N selected" · Clear · the batch's invitation validity (defaults
 *               to the configured Growth setting; an override 1–30 is validated
 *               again by the server) · "Review & approve".
 *   2. REVIEW   the server's DRY RUN: "Approve 12 selected requests — invitation
 *               valid for 14 days", the absolute expiry (UTC), and every row
 *               that will be skipped with its reason. When selected rows carry
 *               review flags the operator must tick an acknowledgement before
 *               Confirm (UI-only, never sent; rows are never removed or blocked).
 *   3. RESULTS  approved / skipped / failed counts (aria-live) with per-row
 *               reasons, after which the list refetches.
 *
 * ONE batchKey per review session (BatchSession): the dry run, the Confirm, and
 * any retry of a failed Confirm all send it, and Confirm is disabled while in
 * flight — a double-click or a retry never issues twice (the server's per-row
 * conditional writes are the guarantee; this keeps the UI from asking).
 *
 * UI-001 — every control renders inside a `canWrite` region; the server gate
 * (fresh GROWTH_REVENUE WRITE) decides regardless.
 */

import { useRef, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import {
  BULK_APPROVE_URL, BatchSession, confirmEnabled, flaggedLine, flaggedRows, newBatchKey, parseDaysDraft,
  previewHeadline, resultsLine, utcExpiryLabel, daysWord, REPEAT_LINE,
  type BulkDryRunResponse, type BulkExecuteResponse, type RiskLike,
} from "./bulk-approve-model";

export interface BulkSelectedRow {
  id: string;
  email: string;
  risk?: RiskLike | null;
}

export interface BulkApprovePanelProps {
  canWrite: boolean;
  selectedRows: readonly BulkSelectedRow[];
  /** The configured validity (the Access panel's data source); null while it loads. */
  validityDefault: number | null;
  min: number;
  max: number;
  onClear: () => void;
  /** After a Confirm answered: clear the selection and refetch the list. */
  onFinished: () => void | Promise<void>;
  /** Test seam — the batchKey minter. */
  mintBatchKey?: () => string;
}

type Stage = "bar" | "review" | "results";

export function BulkApprovePanel({ canWrite, selectedRows, validityDefault, min, max, onClear, onFinished, mintBatchKey }: BulkApprovePanelProps) {
  const session = useRef(new BatchSession(mintBatchKey ?? newBatchKey));
  const inFlightRef = useRef(false); // synchronous double-click guard (state lags a render)
  const [stage, setStage] = useState<Stage>("bar");
  const [daysDraft, setDaysDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState<BulkDryRunResponse | null>(null);
  const [results, setResults] = useState<BulkExecuteResponse | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The rows under review, frozen at "Review & approve" (the list may refetch underneath).
  const [reviewRows, setReviewRows] = useState<readonly BulkSelectedRow[]>([]);

  const days = parseDaysDraft(daysDraft, min, max);
  const shownDays = daysDraft ?? (validityDefault !== null ? String(validityDefault) : "");
  const emailOf = (id: string) => reviewRows.find((r) => r.id === id)?.email ?? id;
  const flagged = flaggedRows(reviewRows);

  async function post<T>(dryRun: boolean): Promise<T | null> {
    const batchKey = dryRun ? session.current.begin() : session.current.current();
    if (!batchKey) return null;
    const ids = (dryRun ? selectedRows : reviewRows).map((r) => r.id);
    const res = await fetch(BULK_APPROVE_URL, {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestIds: ids, batchKey, dryRun,
        ...(days.ok && days.override !== null ? { validityDays: days.override } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
    return body;
  }

  async function review() {
    if (inFlightRef.current || selectedRows.length === 0 || !days.ok) return;
    inFlightRef.current = true;
    setInFlight(true);
    setError(null);
    try {
      setReviewRows([...selectedRows]);
      const p = await post<BulkDryRunResponse>(true);
      if (p) { setPreview(p); setAcknowledged(false); setStage("review"); }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Review failed");
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    if (inFlightRef.current || !confirmEnabled({ inFlight, eligible: preview.summary.eligible, flagged: flagged.length, acknowledged })) return;
    inFlightRef.current = true;
    setInFlight(true);
    setError(null);
    try {
      const r = await post<BulkExecuteResponse>(false);
      if (r) {
        setResults(r);
        setStage("results");
        await onFinished();
      }
    } catch (e) {
      // Stay in review: Confirm again retries the SAME batch (same batchKey).
      setError(e instanceof Error ? `${e.message} — Confirm again to retry; nothing is sent twice.` : "Approval failed");
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  }

  function closeSession() {
    session.current.end();
    setStage("bar");
    setPreview(null);
    setResults(null);
    setAcknowledged(false);
    setError(null);
    setReviewRows([]);
  }

  const btn = "inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 text-xs font-semibold disabled:opacity-40 lg:min-h-8";
  const neutral = { borderColor: "var(--border-hairline)", color: "var(--text-secondary)" };
  const positive = { background: "rgba(52,211,153,.12)", color: "var(--success-400, #34d399)", borderColor: "rgba(52,211,153,.3)" };

  if (stage === "bar" && selectedRows.length === 0) return null;

  return (
    <>
      {canWrite && (
        <div className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-sm)] border p-3" style={{ borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}
          data-bulk-approve aria-label="Bulk approve" role="region">
          {stage === "bar" && (
            <div className="flex min-w-0 flex-wrap items-center gap-2" data-bulk-bar>
              <span className="text-xs font-semibold tabular-nums text-[var(--text-primary)]" data-bulk-count>{`${selectedRows.length} selected`}</span>
              <button type="button" onClick={onClear} disabled={inFlight} className="min-h-11 px-1 text-[11px] text-[var(--text-secondary)] underline-offset-2 hover:underline disabled:opacity-40 lg:min-h-8">
                Clear
              </button>
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                <label htmlFor="growth-bulk-days" className="text-[11px] text-[var(--text-secondary)]">Invitation valid for</label>
                <input id="growth-bulk-days" type="number" inputMode="numeric" min={min} max={max} step={1} value={shownDays} disabled={inFlight}
                  onChange={(e) => setDaysDraft(e.target.value)} aria-describedby="growth-bulk-days-bounds" aria-invalid={!days.ok}
                  className="min-h-11 w-16 rounded-[var(--radius-sm)] border bg-transparent px-2 text-base tabular-nums text-[var(--text-primary)] sm:text-xs lg:min-h-8"
                  style={{ borderColor: days.ok ? "var(--border-hairline)" : "var(--accent-negative)" }} />
                <span id="growth-bulk-days-bounds" className="text-[11px] tabular-nums text-[var(--text-muted)]">{`days (${min}–${max})`}</span>
                {daysDraft !== null && validityDefault !== null && (
                  <button type="button" onClick={() => setDaysDraft(null)} disabled={inFlight} data-bulk-days-reset
                    className="min-h-11 px-1 text-[11px] text-[var(--text-secondary)] underline-offset-2 hover:underline disabled:opacity-40 lg:min-h-8">
                    {`Use default (${daysWord(validityDefault)})`}
                  </button>
                )}
              </span>
              <button type="button" onClick={review} disabled={inFlight || !days.ok} className={`${btn} sm:ml-auto`} style={positive} data-bulk-review>
                {inFlight ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={13} aria-hidden />} Review &amp; approve
              </button>
            </div>
          )}

          {stage === "review" && preview && (
            <div className="flex min-w-0 flex-col gap-2" data-bulk-review-step>
              <p className="text-xs font-semibold text-[var(--text-primary)]" data-bulk-headline>{previewHeadline(preview.summary.eligible, preview.validityDays)}</p>
              <p className="text-[11px] tabular-nums text-[var(--text-secondary)]">
                {`Expires ${utcExpiryLabel(preview.expiresAtIfIssuedNow)} if sent now · ${preview.validitySource === "setting" ? "configured validity" : "override for this batch"}`}
              </p>
              <p className="text-[11px] tabular-nums text-[var(--text-secondary)]" data-bulk-preview-counts>
                {`${preview.summary.eligible} eligible to approve · ${preview.summary.ineligible} will be skipped${preview.summary.duplicates > 0 ? ` · ${preview.summary.duplicates} duplicate${preview.summary.duplicates === 1 ? "" : "s"} counted once` : ""}`}
              </p>
              {preview.rows.some((r) => !r.eligible) && (
                <ul className="flex flex-col gap-1 text-[11px] text-[var(--text-muted)]" aria-label="Will be skipped">
                  {preview.rows.map((r) => (r.eligible ? null : (
                    <li key={r.id} className="min-w-0 break-words"><span className="text-[var(--text-secondary)]">{emailOf(r.id)}</span>{` — ${r.reason}`}</li>
                  )))}
                </ul>
              )}
              {flagged.length > 0 && (
                <label className="flex min-h-11 items-start gap-2 text-[11px] text-[var(--accent-warning)] lg:min-h-0" data-bulk-flag-ack>
                  <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} disabled={inFlight} className="mt-0.5" />
                  <span>{`${flaggedLine(flagged.length, reviewRows.length)}. I have reviewed them and want to approve anyway.`}</span>
                </label>
              )}
              {error && <p role="alert" className="text-[11px] text-[var(--accent-negative)]" data-action-error>{error}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={closeSession} disabled={inFlight} className={btn} style={neutral}>
                  <X size={13} aria-hidden /> Cancel
                </button>
                <button type="button" onClick={confirm} data-bulk-confirm
                  disabled={!confirmEnabled({ inFlight, eligible: preview.summary.eligible, flagged: flagged.length, acknowledged })}
                  className={btn} style={positive}>
                  {inFlight ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={13} aria-hidden />}
                  {`Confirm — approve ${preview.summary.eligible}`}
                </button>
              </div>
            </div>
          )}

          {stage === "results" && results && (
            <div className="flex min-w-0 flex-col gap-2" data-bulk-results>
              {results.repeat && <p className="text-[11px] text-[var(--text-secondary)]" data-bulk-repeat>{REPEAT_LINE}</p>}
              <p className="text-[11px] text-[var(--text-secondary)]">{`Invitations valid ${daysWord(results.validityDays)}.`}</p>
              {results.emailFailed.length > 0 && (
                <ul className="flex flex-col gap-1 text-[11px] text-[var(--accent-warning)]" aria-label="Approved, email not sent" data-bulk-email-failed>
                  {results.emailFailed.map((f) => (
                    <li key={`e-${f.id}`} className="min-w-0 break-words">{`${emailOf(f.id)} — ${f.reason}`}</li>
                  ))}
                </ul>
              )}
              {results.skipped.length + results.failed.length > 0 && (
                <ul className="flex flex-col gap-1 text-[11px] text-[var(--text-muted)]" aria-label="Not approved">
                  {results.skipped.map((s) => (
                    <li key={`s-${s.id}`} className="min-w-0 break-words"><span className="text-[var(--text-secondary)]">{`Skipped · ${emailOf(s.id)}`}</span>{` — ${s.reason}`}</li>
                  ))}
                  {results.failed.map((f) => (
                    <li key={`f-${f.id}`} className="min-w-0 break-words text-[var(--accent-negative)]">{`Failed · ${emailOf(f.id)} — ${f.reason}`}</li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-2">
                <button type="button" onClick={closeSession} className={btn} style={neutral}>Done</button>
              </div>
            </div>
          )}

          {/* One persistent live region: the result counts are announced when they arrive. */}
          <p aria-live="polite" role="status" className="text-xs font-semibold tabular-nums text-[var(--text-primary)]" data-bulk-live>
            {stage === "results" && results ? resultsLine(results.summary) : ""}
          </p>
          {stage === "bar" && error && <p role="alert" className="text-[11px] text-[var(--accent-negative)]" data-action-error>{error}</p>}
        </div>
      )}
    </>
  );
}
