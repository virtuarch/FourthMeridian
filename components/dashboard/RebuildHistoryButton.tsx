"use client";

/**
 * RebuildHistoryButton — the personal-space entry point to the wealth-timeline
 * amendment system (Phase 2). A small toolbar action next to the Net Worth
 * chart's expand control that opens a preview-then-confirm modal:
 *
 *   1. pick the account + what changed + the date range,
 *   2. Preview  → POST /api/spaces/[id]/wealth/amend { preview: true } — a
 *                 read-only per-day before→after diff, nothing written,
 *   3. Confirm  → POST { consent: true } — applies the amendment (rewrites the
 *                 rows, stores the breakdown, writes an AuditLog entry).
 *
 * All logic lives server-side (lib/snapshots/snapshot-amendment.ts + the route);
 * this component only collects input, shows the diff, and confirms. SHARED-space
 * approval is Phase 3, so the caller renders this on PERSONAL spaces only.
 *
 * Shell: the canonical FormModal (→ OverlaySurface) primitive. This is squarely
 * a form (account picker · kind · date range · preview · confirm), so it uses
 * the form-intent preset rather than a hand-rolled div. FormModal owns the
 * frosted glass surface (GlassPanel depth="thick" — an opaque-enough backdrop),
 * portalling into document.body, focus trap, scroll lock, and Escape — the
 * hand-rolled panel previously used --modal-surface with no backdrop-filter, so
 * background content bled through, unlike every other modal in the app.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { History } from "lucide-react";
import { FormModal } from "@/components/atlas/FormModal";

interface AmendAccount {
  id: string;
  name: string;
  type: string;
  /**
   * YYYY-MM-DD of the account's earliest non-deleted transaction — the regen's
   * per-account floor, supplied by GET /api/spaces/[id]/accounts. Used as the
   * "From" input's min so you can't request a rebuild of days before the
   * account has any data. null/absent ⇒ no synced transactions ⇒ no floor.
   */
  earliestTxDate?: string | null;
}

interface DayDiff {
  date: string;
  action: string;
  netWorthBefore: number | null;
  netWorthAfter: number | null;
}
interface AmendSummary {
  consideredDays: number;
  changedDays: number;
  netWorthBefore: number | null;
  netWorthAfter: number | null;
  netWorthDelta: number | null;
}
interface AmendResponse {
  changed: DayDiff[];
  summary: AmendSummary;
  status?: "APPLIED";
}

const KIND_OPTIONS: { value: string; label: string }[] = [
  { value: "ACCOUNT_ADDED_RETROACTIVE", label: "Add this account's history to past days" },
  { value: "ACCOUNT_REMOVED_RETROACTIVE", label: "Remove this account from past days" },
  { value: "ACCOUNT_HARD_DELETED", label: "Erase a permanently-deleted account" },
  { value: "IMPORT_ENRICHMENT", label: "Enrich past days from imported data" },
];

function isoDay(d: Date): string {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x.toISOString().slice(0, 10);
}
function minusDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}
function fmtMoney(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function RebuildHistoryButton({ spaceId, accounts }: { spaceId: string; accounts: AmendAccount[] }): React.ReactElement {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const yesterday = minusDays(isoDay(new Date()), 1);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [kind, setKind] = useState(KIND_OPTIONS[0].value);
  const [fromDate, setFromDate] = useState(minusDays(yesterday, 30));
  const [toDate, setToDate] = useState(yesterday);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<AmendResponse | null>(null);
  const [applied, setApplied] = useState(false);

  function reset(): void {
    setPreview(null);
    setApplied(false);
    setError(null);
  }
  function close(): void {
    setOpen(false);
    reset();
  }

  async function call(consent: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/wealth/amend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, kind, fromDate, toDate, ...(consent ? { consent: true } : { preview: true }) }),
      });
      const data = (await res.json()) as AmendResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      if (consent) {
        setApplied(true);
        setPreview(data);
        router.refresh(); // the chart reads SpaceSnapshot — pull the revised rows
      } else {
        setPreview(data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  // The selected account's earliest-transaction floor bounds the "From" input
  // (recalculated whenever accountId changes, since it's derived from it).
  const fromMin = accounts.find((a) => a.id === accountId)?.earliestTxDate ?? undefined;

  // Switch account → if the current From predates the new account's floor, pull
  // it up to the floor (never past To). Keeps the value inside the valid range
  // rather than leaving a below-min value the picker would flag.
  function selectAccount(id: string): void {
    setAccountId(id);
    const floor = accounts.find((a) => a.id === id)?.earliestTxDate;
    if (floor && fromDate < floor) setFromDate(floor > toDate ? toDate : floor);
    reset();
  }

  // Footer action bar — Done after a commit, else Cancel + Preview/Confirm.
  const footer = applied ? (
    <div className="flex justify-end">
      <button onClick={close} className="h-8 px-4 rounded-lg text-sm font-medium bg-[var(--accent)] text-white hover:opacity-90">Done</button>
    </div>
  ) : (
    <div className="flex justify-end gap-2">
      <button onClick={close} disabled={busy} className="h-8 px-3 rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50">Cancel</button>
      {!preview ? (
        <button onClick={() => call(false)} disabled={busy || !accountId} className="h-8 px-4 rounded-lg text-sm font-medium bg-[var(--surface-hover)] text-[var(--text-primary)] border border-[var(--border-hairline-strong)] hover:opacity-90 disabled:opacity-50">
          {busy ? "Previewing…" : "Preview"}
        </button>
      ) : (
        <button onClick={() => call(true)} disabled={busy || preview.summary.changedDays === 0} className="h-8 px-4 rounded-lg text-sm font-medium bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50">
          {busy ? "Rebuilding…" : "Confirm rebuild"}
        </button>
      )}
    </div>
  );

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Rebuild wealth history"
        title="Rebuild wealth history"
        className="h-7 px-2 flex items-center gap-1 rounded-lg text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors touch-manipulation"
      >
        <History size={13} />
        <span className="hidden sm:inline">Rebuild history</span>
      </button>

      <FormModal
        open={open}
        onClose={close}
        title="Rebuild wealth history"
        icon={History}
        preventClose={busy}
        footer={footer}
      >
        {applied ? (
          <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-muted)] p-3">
            <p className="text-sm font-medium text-[var(--text-primary)]">History rebuilt.</p>
            <p className="text-[12px] text-[var(--text-secondary)] mt-1">
              {preview?.summary.changedDays ?? 0} day(s) revised.{" "}
              {preview?.summary.netWorthBefore != null && preview?.summary.netWorthAfter != null && (
                <>Net worth {fmtMoney(preview.summary.netWorthBefore)} → {fmtMoney(preview.summary.netWorthAfter)}.</>
              )}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-[12px] text-[var(--text-muted)] leading-snug">
              Deliberately revise already-recorded history for this personal space. Preview the
              before → after change first; nothing is written until you confirm.
            </p>

            <label className="block">
              <span className="text-[11px] font-medium text-[var(--text-secondary)]">Account</span>
              <select
                value={accountId}
                onChange={(e) => selectAccount(e.target.value)}
                className="mt-1 w-full h-9 px-2 rounded-lg text-sm bg-[var(--surface-muted)] border border-[var(--border-hairline)] text-[var(--text-primary)]"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({a.type})</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-[11px] font-medium text-[var(--text-secondary)]">What changed</span>
              <select
                value={kind}
                onChange={(e) => { setKind(e.target.value); reset(); }}
                className="mt-1 w-full h-9 px-2 rounded-lg text-sm bg-[var(--surface-muted)] border border-[var(--border-hairline)] text-[var(--text-primary)]"
              >
                {KIND_OPTIONS.map((k) => (
                  <option key={k.value} value={k.value}>{k.label}</option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[11px] font-medium text-[var(--text-secondary)]">From</span>
                <input type="date" value={fromDate} min={fromMin} max={toDate} onChange={(e) => { setFromDate(e.target.value); reset(); }}
                  className="mt-1 w-full h-9 px-2 rounded-lg text-sm bg-[var(--surface-muted)] border border-[var(--border-hairline)] text-[var(--text-primary)]" />
              </label>
              <label className="block">
                <span className="text-[11px] font-medium text-[var(--text-secondary)]">To</span>
                <input type="date" value={toDate} min={fromDate} max={yesterday} onChange={(e) => { setToDate(e.target.value); reset(); }}
                  className="mt-1 w-full h-9 px-2 rounded-lg text-sm bg-[var(--surface-muted)] border border-[var(--border-hairline)] text-[var(--text-primary)]" />
              </label>
            </div>

            {error && <p className="text-[12px] text-[var(--danger,#e5484d)]">{error}</p>}

            {preview && (
              <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-muted)] p-3 space-y-2">
                <p className="text-[12px] text-[var(--text-secondary)]">
                  <span className="font-medium text-[var(--text-primary)]">{preview.summary.changedDays}</span> of{" "}
                  {preview.summary.consideredDays} day(s) would change.
                  {preview.summary.netWorthBefore != null && preview.summary.netWorthAfter != null && (
                    <> Net worth {fmtMoney(preview.summary.netWorthBefore)} → {fmtMoney(preview.summary.netWorthAfter)}.</>
                  )}
                </p>
                {preview.changed.length > 0 && (
                  <div className="max-h-40 overflow-y-auto text-[11px] font-mono text-[var(--text-secondary)] space-y-0.5">
                    {preview.changed.slice(0, 60).map((d) => (
                      <div key={d.date} className="flex justify-between gap-2">
                        <span>{d.date}</span>
                        <span>{fmtMoney(d.netWorthBefore)} → {fmtMoney(d.netWorthAfter)}</span>
                      </div>
                    ))}
                    {preview.changed.length > 60 && <div className="text-[var(--text-muted)]">…and {preview.changed.length - 60} more</div>}
                  </div>
                )}
                {preview.summary.changedDays === 0 && (
                  <p className="text-[11px] text-[var(--text-muted)]">Nothing would change for this range — no rebuild needed.</p>
                )}
              </div>
            )}
          </div>
        )}
      </FormModal>
    </>
  );
}
