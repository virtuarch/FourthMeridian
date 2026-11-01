"use client";
/**
 * components/platform/widgets/WalletHistoryRecoveryPanel.tsx  (OPS — audited per-wallet history recovery)
 *
 * "Resume history" for ONE self-custody wallet, inside the Connection
 * diagnostics panel (OpsConnectionDiagnosticsWidget), never on a customer
 * surface.
 *
 *   Review   → GET connections/[id]/history-resume (reads only): state, failure
 *              code, verified range, progress, today's budget, worker flag, and
 *              whether resume is allowed now — or why not.
 *   Resume   → POST with a structured reason AND a note; two clicks (arm, then
 *              confirm). The server re-reads the connection, re-checks every
 *              rule, runs one bounded pass and returns the structured result.
 *
 * Rendered only when the host passes `editable` (the operator holds the top
 * Platform Operations rank); the SERVER is the authority and re-checks fresh.
 * Mounted with `key={connectionId}` so a different wallet starts clean.
 * Facts only: no address beyond the label the diagnostics already show.
 */
import { useEffect, useState } from "react";
import { History, Loader2, RotateCcw } from "lucide-react";
import { OPERATOR_REASON_CODES, OPERATOR_NOTE_MAX, type OperatorReasonCode } from "@/lib/audit";
import type { HistoryResumePreviewResponse, HistoryResumeResponse } from "@/app/api/platform/platform-ops/connections/[id]/history-resume/route";
import { BTN, BTN_PRIMARY, BTN_NEUTRAL, FIELD } from "./policy-editor-kit";
import { RECOVERY_PANEL_TITLE, RESUME_CONFIRM_TEXT, historyResumeUrl, previewLines, refusalNotice, resultLines } from "./wallet-history-recovery-view";

/** Presentational — every state provable by handing it props. */
export function HistoryResumeSurface({
  preview, loadError, result, error, busy, armed, reason, note, onReason, onNote, onResume, onCancel,
}: {
  preview: HistoryResumePreviewResponse | null;
  loadError: string | null;
  result: HistoryResumeResponse | null;
  error: string | null;
  busy: boolean;
  armed: boolean;
  reason: OperatorReasonCode | "";
  note: string;
  onReason: (r: OperatorReasonCode | "") => void;
  onNote: (n: string) => void;
  onResume: () => void;
  onCancel: () => void;
}) {
  const ready = reason !== "" && note.trim() !== "";
  const notice = preview ? refusalNotice(preview) : null;
  return (
    <section aria-label={RECOVERY_PANEL_TITLE} className="flex flex-col gap-2 border-t border-[var(--border-hairline)] pt-3">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        <History size={12} aria-hidden /> {RECOVERY_PANEL_TITLE}
      </p>
      {loadError && <p role="alert" className="text-[11px] text-[var(--danger-400,#f87171)]">{loadError}</p>}
      {!preview && !loadError && (
        <p role="status" className="text-[11px] text-[var(--text-muted)]"><Loader2 size={11} className="inline animate-spin" aria-hidden /> Loading…</p>
      )}
      {preview && (
        <ul className="flex flex-col gap-0.5 text-[11px] text-[var(--text-secondary)]">
          {previewLines(preview).map((l) => <li key={l}>{l}</li>)}
        </ul>
      )}
      {notice && !result && (
        notice.warn
          ? <p role="alert" className="text-[11px] text-[var(--brass-300)]">{notice.text}</p>
          : <p className="text-[11px] text-[var(--text-muted)]">{notice.text}</p>
      )}
      {preview?.allowed && !result && (
        <div className="flex flex-col gap-2">
          <label className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-secondary)]">
            Reason
            <select value={reason} onChange={(e) => onReason(e.target.value as OperatorReasonCode | "")} disabled={busy} required className={FIELD} style={{ borderColor: "var(--border-hairline)" }}>
              <option value="">Choose a reason…</option>
              {OPERATOR_REASON_CODES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ").toLowerCase()}</option>)}
            </select>
          </label>
          <input type="text" value={note} onChange={(e) => onNote(e.target.value)} disabled={busy} maxLength={OPERATOR_NOTE_MAX} required
            placeholder="Why this wallet is being resumed (required)" aria-label="Reason note (required)" className={FIELD} style={{ borderColor: "var(--border-hairline)" }} />
          {armed && <p role="alert" className="text-[11px] text-[var(--brass-300)]">{RESUME_CONFIRM_TEXT}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onResume} disabled={busy || !ready} className={BTN} style={BTN_PRIMARY}>
              {busy ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <RotateCcw size={11} aria-hidden />} {armed ? "Confirm resume" : "Resume history"}
            </button>
            {armed && <button type="button" onClick={onCancel} disabled={busy} className={BTN} style={BTN_NEUTRAL}>Cancel</button>}
          </div>
        </div>
      )}
      {result && (
        <ul role="status" className="flex flex-col gap-0.5 text-[11px] text-[var(--text-primary)]">
          {resultLines(result).map((l) => <li key={l}>{l}</li>)}
        </ul>
      )}
      {error && <p role="alert" className="text-[11px] text-[var(--danger-400,#f87171)]">{error}</p>}
    </section>
  );
}

export function WalletHistoryRecoveryPanel({ connectionId }: { connectionId: string }) {
  const [preview, setPreview] = useState<HistoryResumePreviewResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [result, setResult] = useState<HistoryResumeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [reason, setReason] = useState<OperatorReasonCode | "">("");
  const [note, setNote] = useState("");

  useEffect(() => {
    let live = true;
    fetch(historyResumeUrl(connectionId), { credentials: "same-origin" })
      .then(async (r) => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error ?? `Could not load history state (${r.status}).`); return b; })
      .then((b: HistoryResumePreviewResponse) => { if (live) setPreview(b); })
      .catch((e: unknown) => { if (live) setLoadError(e instanceof Error ? e.message : "Could not load history state."); });
    return () => { live = false; };
  }, [connectionId]);

  async function resume() {
    if (!reason || !note.trim()) return;
    if (!armed) { setArmed(true); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch(historyResumeUrl(connectionId), {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: { code: reason, note: note.trim() } }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(r.status === 403 ? "Not authorized to resume wallet history." : (b.error ?? `Resume failed (${r.status}).`));
      setResult(b as HistoryResumeResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resume failed.");
    } finally {
      setBusy(false); setArmed(false);
    }
  }

  return (
    <HistoryResumeSurface preview={preview} loadError={loadError} result={result} error={error} busy={busy} armed={armed}
      reason={reason} note={note} onReason={(v) => { setReason(v); setArmed(false); }} onNote={setNote} onResume={resume} onCancel={() => setArmed(false)} />
  );
}
