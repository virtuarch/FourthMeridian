"use client";

/**
 * components/connections/import/ImportHistoryWizard.tsx
 *
 * A7-6 — the historical investment import wizard, opened from a ConnectionCard.
 * Upload → Preview (with the safety verdict) → Commit → History/Rollback. Thin
 * over the A7 backend: it never re-implements dedupe, detection, or provenance —
 * it renders the server's `buildImportPreview` verdict and posts to the canonical
 * routes. Reuses FormModal + GlassButton + ConfirmDialog; local loading/error
 * state (no toast provider), SyncWalletButton async pattern.
 *
 * Safety surfaced here: a blocking verdict (wrong provider, non-investment, wrong
 * / multi account) DISABLES import and explains why; an unproven-but-plausible
 * file requires an explicit confirmation checkbox before import is enabled. The
 * server re-checks the same gate, so the UI can never bypass it. Account
 * identifiers are shown only as masked labels the server already produced.
 */

import { useCallback, useEffect, useState } from "react";
import { FormModal } from "@/components/atlas/FormModal";
import { GlassButton } from "@/components/atlas/GlassButton";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { AlertTriangle, CheckCircle2, Info, Loader2, Upload } from "lucide-react";

// ── Server response shapes (from the A7-6 routes) ────────────────────────────
interface ImportableAccount { id: string; name: string; type: string; label: string; institution: string | null }
interface Counts { create: number; match: number; skip: number; failed: number }
interface PreviewResponse {
  target: { id: string; label: string; institution: string | null };
  detection: { source: string; confidence: string; evidence: string[]; investmentLike: boolean; branded: boolean };
  compatibility: { compatible: boolean; blockingMismatch: boolean; requiresConfirmation: boolean; reason: string };
  account: { verdict: string; blocking: boolean; requiresConfirmation: boolean; reason: string };
  file: { verdict: string; blocking: boolean; reason: string };
  counts: Counts;
  dateRange: { from: string | null; to: string | null };
  canCommit: boolean;
  requiresConfirmation: boolean;
  blockingReasons: string[];
}
interface BatchSummary {
  id: string; filename: string | null; importedAt: string; source: string; status: string; rolledBack: boolean;
  account: { id: string; label: string };
  counts: { rowCount: number; importedCount: number; matchedCount: number; skippedCount: number; failedCount: number };
}

type Step = "upload" | "preview" | "done" | "history";

const PROFILES = [
  { key: "csv:schwab", label: "Charles Schwab" },
  { key: "csv:generic", label: "Generic investment CSV" },
];

export function ImportHistoryWizard({
  connectionId, institution, onClose,
}: { connectionId: string; institution: string; onClose: () => void }) {
  const [step, setStep] = useState<Step>("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Upload state
  const [accounts, setAccounts] = useState<ImportableAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [profileKey, setProfileKey] = useState("csv:schwab");
  const [rowKind, setRowKind] = useState<"transactions" | "positions">("transactions");
  const [file, setFile] = useState<File | null>(null);

  // Preview / commit
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<{ importBatchId: string; counts: Counts } | null>(null);

  // History / rollback
  const [history, setHistory] = useState<BatchSummary[]>([]);
  const [rollbackId, setRollbackId] = useState<string | null>(null);

  const label = (id: string) => accounts.find((a) => a.id === id)?.label ?? "the selected account";

  // Load the connection's investment accounts (stable ids) on open.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/connections/${connectionId}/import-accounts`);
        const d = await r.json();
        const list: ImportableAccount[] = d.accounts ?? [];
        setAccounts(list);
        if (list[0]) setAccountId(list[0].id);
      } catch { setError("Could not load this connection's accounts."); }
    })();
  }, [connectionId]);

  const runPreview = useCallback(async () => {
    if (!file || !accountId) { setError("Choose a target account and a file."); return; }
    setError(""); setBusy(true); setConfirmed(false);
    try {
      const fd = new FormData();
      fd.append("file", file); fd.append("profileKey", profileKey); fd.append("rowKind", rowKind);
      const r = await fetch(`/api/accounts/${accountId}/import/investments/preview`, { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) { setError(d.error ?? "Preview failed. Please try again."); return; }
      setPreview(d); setStep("preview");
    } catch { setError("Network error while previewing. Your selections are kept — try again."); }
    finally { setBusy(false); }
  }, [file, accountId, profileKey, rowKind]);

  const commit = useCallback(async () => {
    if (!file || !accountId || !preview) return;
    setError(""); setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file); fd.append("profileKey", profileKey); fd.append("rowKind", rowKind);
      if (preview.requiresConfirmation) fd.append("acknowledged", String(confirmed));
      const r = await fetch(`/api/accounts/${accountId}/import/investments`, { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) {
        // Server re-checked the gate — surface the blocking reasons, stay on preview.
        setError(d.error ?? "Import failed. Please try again.");
        if (d.preview) setPreview(d.preview);
        return;
      }
      setResult({ importBatchId: d.importBatchId, counts: d.counts }); setStep("done");
    } catch { setError("Network error while importing. Nothing was imported — try again."); }
    finally { setBusy(false); }
  }, [file, accountId, profileKey, rowKind, preview, confirmed]);

  const loadHistory = useCallback(async () => {
    setError(""); setBusy(true);
    try {
      const r = await fetch(`/api/connections/${connectionId}/import-history`);
      const d = await r.json();
      setHistory(d.history ?? []); setStep("history");
    } catch { setError("Could not load import history."); }
    finally { setBusy(false); }
  }, [connectionId]);

  const doRollback = useCallback(async (batchId: string) => {
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/imports/${batchId}/rollback`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) { setError(d.error ?? "Rollback failed."); return; }
      await loadHistory(); // reflect the actual backend result
    } catch { setError("Network error during rollback."); }
    finally { setBusy(false); setRollbackId(null); }
  }, [loadHistory]);

  const commitEnabled = !!preview?.canCommit && (!preview?.requiresConfirmation || confirmed);

  return (
    <FormModal
      open
      onClose={() => { if (!busy) onClose(); }}
      preventClose={busy}
      title="Import historical data"
      subtitle={institution}
      footer={<WizardFooter step={step} busy={busy} commitEnabled={commitEnabled}
        onBack={() => setStep("upload")} onPreview={runPreview} onCommit={commit}
        onHistory={loadHistory} onClose={onClose} hasResult={!!result} />}
    >
      {error && <Banner tone="error" text={error} />}

      {step === "upload" && (
        <UploadStep accounts={accounts} accountId={accountId} setAccountId={setAccountId}
          profileKey={profileKey} setProfileKey={setProfileKey} rowKind={rowKind} setRowKind={setRowKind}
          file={file} setFile={setFile} />
      )}

      {step === "preview" && preview && (
        <PreviewStep preview={preview} confirmed={confirmed} setConfirmed={setConfirmed} targetLabel={label(accountId)} />
      )}

      {step === "done" && result && (
        <div className="space-y-3 py-2">
          <div className="flex items-center gap-2 text-[var(--accent-positive,#34d399)]"><CheckCircle2 size={18} /><span className="font-semibold">Import complete</span></div>
          <ul className="text-sm text-[var(--text-secondary)] space-y-1">
            <li>{result.counts.create} added · {result.counts.match} already present · {result.counts.skip} skipped · {result.counts.failed} unreadable</li>
            <li className="text-[var(--text-muted)]">Batch {result.importBatchId}</li>
          </ul>
        </div>
      )}

      {step === "history" && (
        <HistoryStep history={history} onRollback={setRollbackId} />
      )}

      {rollbackId && (
        <ConfirmDialog
          open onClose={() => setRollbackId(null)} onConfirm={() => doRollback(rollbackId)} busy={busy}
          title="Roll back this import?"
          message="This removes the imported events and observations and returns affected positions to their prior state. The batch stays visible in history."
          confirmLabel="Roll back"
        />
      )}
    </FormModal>
  );
}

// ── Steps ────────────────────────────────────────────────────────────────────

function UploadStep(props: {
  accounts: ImportableAccount[]; accountId: string; setAccountId: (v: string) => void;
  profileKey: string; setProfileKey: (v: string) => void; rowKind: "transactions" | "positions"; setRowKind: (v: "transactions" | "positions") => void;
  file: File | null; setFile: (f: File | null) => void;
}) {
  const { accounts, accountId, setAccountId, profileKey, setProfileKey, rowKind, setRowKind, file, setFile } = props;
  if (accounts.length === 0) return <Banner tone="info" text="This connection has no investment accounts to import into." />;
  return (
    <div className="space-y-4 py-1">
      <Field label="Target account">
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls}>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.label}</option>)}
        </select>
      </Field>
      <Field label="Broker format">
        <select value={profileKey} onChange={(e) => setProfileKey(e.target.value)} className={selectCls}>
          {PROFILES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </Field>
      <Field label="File contains">
        <select value={rowKind} onChange={(e) => setRowKind(e.target.value as "transactions" | "positions")} className={selectCls}>
          <option value="transactions">Transaction history</option>
          <option value="positions">Positions statement (holdings)</option>
        </select>
      </Field>
      <Field label="CSV export">
        <label className="flex items-center gap-2 cursor-pointer text-sm text-[var(--text-secondary)]">
          <Upload size={15} />
          <span>{file ? file.name : "Choose a CSV file…"}</span>
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      </Field>
    </div>
  );
}

function PreviewStep({ preview, confirmed, setConfirmed, targetLabel }: { preview: PreviewResponse; confirmed: boolean; setConfirmed: (v: boolean) => void; targetLabel: string }) {
  const { detection, compatibility, account, file, counts, dateRange, canCommit, requiresConfirmation, blockingReasons } = preview;
  return (
    <div className="space-y-3 py-1 text-sm">
      {blockingReasons.length > 0 && blockingReasons.map((r, i) => <Banner key={i} tone="error" text={r} />)}
      {canCommit && !compatibility.compatible && <Banner tone="warning" text={compatibility.reason} />}
      {canCommit && compatibility.compatible && <Banner tone="ok" text={compatibility.reason} />}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[var(--text-secondary)]">
        <Row k="Detected source" v={detection.branded ? `${detection.source.replace("csv:", "")} (${detection.confidence})` : "generic / unknown"} />
        <Row k="Target account" v={targetLabel} />
        <Row k="Date range" v={dateRange.from ? `${dateRange.from} → ${dateRange.to}` : "—"} />
        <Row k="New records" v={String(counts.create)} />
        <Row k="Already present" v={String(counts.match)} />
        <Row k="Skipped / unreadable" v={`${counts.skip} / ${counts.failed}`} />
        <Row k="File check" v={file.verdict} />
        <Row k="Account check" v={account.verdict} />
      </dl>

      {counts.create === 0 && counts.match > 0 && file.verdict === "duplicate-only" && (
        <Banner tone="info" text="Every record is already imported — importing again will change nothing." />
      )}

      {canCommit && requiresConfirmation && (
        <label className="flex items-start gap-2 mt-2 text-[var(--text-secondary)] cursor-pointer">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
          <span>I confirm this file belongs to {targetLabel}.</span>
        </label>
      )}
    </div>
  );
}

function HistoryStep({ history, onRollback }: { history: BatchSummary[]; onRollback: (id: string) => void }) {
  if (history.length === 0) return <Banner tone="info" text="No imports yet for this connection." />;
  return (
    <ul className="divide-y divide-[var(--border-hairline)] text-sm">
      {history.map((b) => (
        <li key={b.id} className="py-2.5 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[var(--text-primary)] truncate">{b.filename ?? "Imported file"}</p>
            <p className="text-xs text-[var(--text-muted)]">
              {new Date(b.importedAt).toLocaleDateString()} · {b.account.label} · {b.counts.importedCount} added
              {b.rolledBack ? " · rolled back" : ""}
            </p>
          </div>
          {!b.rolledBack && b.status !== "ROLLED_BACK" && (
            <GlassButton tone="danger" size="sm" onClick={() => onRollback(b.id)}>Roll back</GlassButton>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── Footer + small UI helpers ────────────────────────────────────────────────

function WizardFooter({ step, busy, commitEnabled, onBack, onPreview, onCommit, onHistory, onClose, hasResult }: {
  step: Step; busy: boolean; commitEnabled: boolean; onBack: () => void; onPreview: () => void; onCommit: () => void; onHistory: () => void; onClose: () => void; hasResult: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <GlassButton tone="neutral" size="sm" onClick={onHistory} disabled={busy}>Import history</GlassButton>
      <div className="flex items-center gap-2">
        {step === "upload" && <GlassButton tone="meridian" onClick={onPreview} disabled={busy}>{busy ? <Loader2 size={14} className="animate-spin" /> : "Preview"}</GlassButton>}
        {step === "preview" && <>
          <GlassButton tone="neutral" size="sm" onClick={onBack} disabled={busy}>Back</GlassButton>
          <GlassButton tone="meridian" onClick={onCommit} disabled={busy || !commitEnabled}>{busy ? <Loader2 size={14} className="animate-spin" /> : "Import"}</GlassButton>
        </>}
        {(step === "done" || step === "history") && <GlassButton tone="neutral" onClick={onClose} disabled={busy}>{hasResult ? "Done" : "Close"}</GlassButton>}
      </div>
    </div>
  );
}

const selectCls = "w-full rounded-[var(--radius-sm)] px-3 py-2 text-sm text-[var(--text-primary)] bg-[var(--surface-muted)] border border-[var(--border-hairline)] focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="block text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">{label}</label>{children}</div>;
}
function Row({ k, v }: { k: string; v: string }) {
  return <><dt className="text-[var(--text-muted)]">{k}</dt><dd className="text-right text-[var(--text-primary)]">{v}</dd></>;
}
function Banner({ tone, text }: { tone: "error" | "warning" | "ok" | "info"; text: string }) {
  const map = {
    error:   { c: "var(--accent-negative,#f87171)", I: AlertTriangle },
    warning: { c: "var(--accent-warning,#f59e0b)",  I: AlertTriangle },
    ok:      { c: "var(--accent-positive,#34d399)", I: CheckCircle2 },
    info:    { c: "var(--text-muted)",              I: Info },
  }[tone];
  const I = map.I;
  return (
    <div className="flex items-start gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-sm my-1" style={{ background: "var(--surface-muted)", color: map.c }}>
      <I size={15} className="shrink-0 mt-0.5" /><span>{text}</span>
    </div>
  );
}
