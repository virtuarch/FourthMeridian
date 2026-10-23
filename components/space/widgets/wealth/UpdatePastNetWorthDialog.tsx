"use client";

/**
 * components/space/widgets/wealth/UpdatePastNetWorthDialog.tsx   (RWA-2B)
 *
 * "Update past net worth?" — the CONSENT step after a manual real asset gains
 * history in a PERSONAL Space. Past net worth stays exactly as recorded unless
 * the user confirms here.
 *
 * It reuses the existing amendment route and library and adds NO write path:
 *   1. on open: POST /api/spaces/[id]/wealth/amend { preview: true } over
 *      [first anchor, yesterday] — a dry run; the server computes the plan and
 *      writes nothing;
 *   2. the preview is CLIPPED to days that already have a net-worth row
 *      (lib/snapshots/real-asset-amendment-offer.core.ts) and shown: how many
 *      days, between which dates, and net worth on the most recent of them as
 *      recorded → as it would read;
 *   3. only on the explicit "Update past net worth" click: the same POST with
 *      { consent: true } over the CLIPPED range. The route applies only under
 *      `consent === true`; everything else is a preview.
 *
 * Never auto-applied. A SHARED Space never reaches this dialog (the offer logic
 * refuses it, and the server refuses it again). Modeled days are described as
 * modeled — a straight line between the user's dated estimates — never as
 * observed.
 */

import { useEffect, useState } from "react";
import { History, Loader2 } from "lucide-react";
import { FormModal } from "@/components/atlas/FormModal";
import { GlassButton } from "@/components/atlas/GlassButton";
import { formatCurrencyWhole } from "@/lib/currency";
import { formatDate } from "@/lib/format";
import { MODELED_HISTORY_MEANING } from "@/lib/assets/valuation-series.core";
import {
  clipAmendmentPreview, type AmendmentOffer, type ClippedPreview, type PreviewDay,
} from "@/lib/snapshots/real-asset-amendment-offer.core";

/** The amendment kind this flow uses — the existing "enrich past days with a long-held account". */
export const REAL_ASSET_AMENDMENT_KIND = "ACCOUNT_ADDED_RETROACTIVE";

type Phase =
  | { kind: "previewing" }
  | { kind: "nothing"; reason: string }
  | { kind: "ready"; clipped: ClippedPreview }
  | { kind: "applying"; clipped: ClippedPreview }
  | { kind: "applied"; changedDays: number }
  | { kind: "failed"; error: string; clipped: ClippedPreview | null };

export function UpdatePastNetWorthDialog({
  spaceId, accountId, assetName, currency, offer, onClose, onApplied,
}: {
  spaceId:   string;
  accountId: string;
  assetName: string;
  currency:  string;
  /** [first anchor, yesterday] — from realAssetAmendmentOffer (PERSONAL only). */
  offer:     AmendmentOffer;
  onClose:   () => void;
  /** Fired after a CONSENTED apply succeeded, so the host re-reads its history. */
  onApplied: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "previewing" });

  // 1. Preview — read-only on the server (dryRun), nothing is written.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/wealth/amend`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ accountId, kind: REAL_ASSET_AMENDMENT_KIND, fromDate: offer.fromDate, toDate: offer.toDate, preview: true }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) { setPhase({ kind: "failed", error: data.error ?? "Couldn't preview the change.", clipped: null }); return; }
        const clipped = clipAmendmentPreview((data.days ?? []) as PreviewDay[], offer);
        if (!clipped) { setPhase({ kind: "nothing", reason: "Your net worth history doesn't reach back that far yet, so there is nothing to update." }); return; }
        if (clipped.changedDays === 0) { setPhase({ kind: "nothing", reason: "Your past net worth already reflects this value history — nothing would change." }); return; }
        setPhase({ kind: "ready", clipped });
      } catch {
        if (!cancelled) setPhase({ kind: "failed", error: "Couldn't preview the change.", clipped: null });
      }
    })();
    return () => { cancelled = true; };
  }, [spaceId, accountId, offer]);

  // 3. The consented commit — only from the explicit confirm button, over the clipped range.
  async function confirm(clipped: ClippedPreview) {
    setPhase({ kind: "applying", clipped });
    try {
      const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/wealth/amend`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ accountId, kind: REAL_ASSET_AMENDMENT_KIND, fromDate: clipped.fromDate, toDate: clipped.toDate, consent: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setPhase({ kind: "failed", error: data.error ?? "Couldn't update past net worth.", clipped }); return; }
      setPhase({ kind: "applied", changedDays: Number(data?.summary?.changedDays ?? clipped.changedDays) });
      onApplied();
    } catch {
      setPhase({ kind: "failed", error: "Couldn't update past net worth.", clipped });
    }
  }

  const busy = phase.kind === "previewing" || phase.kind === "applying";
  const ready = phase.kind === "ready" ? phase.clipped : phase.kind === "applying" ? phase.clipped : phase.kind === "failed" ? phase.clipped : null;

  return (
    <FormModal
      open
      onClose={() => { if (!busy) onClose(); }}
      title="Update past net worth?"
      subtitle={assetName}
      size="sm"
      preventClose={busy}
      footer={
        <div className="space-y-3">
          {phase.kind === "failed" && <p className="text-xs text-[var(--coral-400)] text-center" role="alert">{phase.error}</p>}
          {phase.kind === "applied" ? (
            <GlassButton tone="neutral" fullWidth onClick={onClose}>Done</GlassButton>
          ) : (
            <div className="flex gap-2">
              <GlassButton tone="neutral" fullWidth onClick={onClose} disabled={busy}>
                Keep history as recorded
              </GlassButton>
              <GlassButton
                tone="meridian" fullWidth
                disabled={busy || !ready}
                onClick={() => { if (ready) void confirm(ready); }}
              >
                {phase.kind === "applying" ? <Loader2 size={14} className="animate-spin" /> : <History size={14} />}
                {phase.kind === "applying" ? "Updating…" : "Update past net worth"}
              </GlassButton>
            </div>
          )}
        </div>
      }
    >
      <div className="space-y-3 text-sm text-[var(--text-secondary)]">
        <p>
          {assetName}&rsquo;s value history now starts {formatDate(offer.fromDate)}. Your past net worth was
          recorded without it and stays that way unless you choose to update it.
        </p>

        {phase.kind === "previewing" && (
          <p className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <Loader2 size={12} className="animate-spin" /> Checking which days would change…
          </p>
        )}

        {phase.kind === "nothing" && <p className="text-xs text-[var(--text-muted)]">{phase.reason}</p>}

        {ready && (
          <div
            className="rounded-[var(--radius-sm)] border p-3 space-y-1.5"
            style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
            data-amendment-preview
          >
            <p className="text-xs text-[var(--text-muted)]">What would change</p>
            <p>
              <span className="font-medium text-[var(--text-primary)] tabular-nums">{ready.changedDays}</span>{" "}
              day{ready.changedDays === 1 ? "" : "s"}
              {ready.firstChanged && ready.lastChanged
                ? <> between {formatDate(ready.firstChanged)} and {formatDate(ready.lastChanged)}</>
                : null}
            </p>
            {ready.lastChanged && ready.netWorthBefore !== null && ready.netWorthAfter !== null && (
              <p>
                Net worth on {formatDate(ready.lastChanged)}:{" "}
                <span className="tabular-nums text-[var(--text-primary)]">{formatCurrencyWhole(ready.netWorthBefore, currency)}</span>
                {" → "}
                <span className="tabular-nums font-medium text-[var(--text-primary)]">{formatCurrencyWhole(ready.netWorthAfter, currency)}</span>
              </p>
            )}
            {ready.skippedBeforeHistory > 0 && (
              <p className="text-xs text-[var(--text-muted)]">
                Days before your net worth history begins are not created.
              </p>
            )}
          </div>
        )}

        {phase.kind === "applied" && (
          <p className="text-xs text-[var(--text-muted)]">
            Updated {phase.changedDays} day{phase.changedDays === 1 ? "" : "s"}. Revised days are marked as estimates on your chart.
          </p>
        )}

        <p className="text-[11px] text-[var(--text-muted)]">
          {MODELED_HISTORY_MEANING} Days you update are shown as modeled, not observed.
        </p>
      </div>
    </FormModal>
  );
}
