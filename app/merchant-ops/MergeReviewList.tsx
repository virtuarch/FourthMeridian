"use client";

/**
 * app/merchant-ops/MergeReviewList.tsx  (MI2 S2 — merge review surface)
 *
 * The client half of the review surface: renders each pending candidate card and,
 * for a holder who can decide, two actions — Merge / Not the same. Each opens a
 * ConfirmDialog that states the outcome and collects the REQUIRED operator reason
 * (SEC-PLAT-2, lib/audit.ts REASON_REQUIRED_ACTIONS; never pre-selected). Confirm
 * POSTs the verdict to /api/merchant-ops/decide, shows the outcome, and refreshes.
 * It carries ZERO merchant logic: it never computes a merge, never resolves ids,
 * never decides a survivor (the server pre-selected it). The route re-checks a
 * FRESH MERCHANT_OPS WRITE grant and the reason; a refusal is shown in the dialog.
 */

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { GitMerge, X, CheckCircle2 } from "lucide-react";
import type { PendingMergeCandidate } from "@/lib/transactions/merchant-merge-review";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { GlassButton } from "@/components/atlas/GlassButton";
import { EMPTY_OPERATOR_REASON, OperatorReasonField, reasonPayload, type OperatorReasonValue } from "@/components/platform/widgets/OperatorReasonField";
import { CandidateCard } from "./ReviewChrome";
import { dialogCopy, outcomeLine, type Verdict } from "./review-model";

// ≥ 44 px tap targets below lg; side by side, each half-width on a phone.
const ACTION = "min-h-11 flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] sm:flex-none lg:min-h-9";

const keyOf = (c: PendingMergeCandidate) => `${c.survivorKey}→${c.absorbedKey}`;

export function MergeReviewList({ candidates, canDecide, empty = null }: { candidates: PendingMergeCandidate[]; canDecide: boolean; empty?: ReactNode }) {
  const router = useRouter();
  const [pending, setPending] = useState<{ candidate: PendingMergeCandidate; verdict: Verdict } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  // A decided pair leaves the list at once (the server refresh confirms it), so
  // a fast second click can never open a dialog on a pair that is gone.
  const [decided, setDecided] = useState<ReadonlySet<string>>(() => new Set());
  const outcomeRef = useRef<HTMLParagraphElement>(null);
  // SEC-PLAT-2 — every verdict carries a required, operator-chosen reason
  // (lib/audit.ts REASON_REQUIRED_ACTIONS); never pre-selected, reset per dialog.
  const [reason, setReason] = useState<OperatorReasonValue>(EMPTY_OPERATOR_REASON);
  const chosen = reasonPayload(reason);

  function open(candidate: PendingMergeCandidate, verdict: Verdict) {
    setPending({ candidate, verdict });
    setReason(EMPTY_OPERATOR_REASON);
    setError(null);
    setOutcome(null);
  }

  function close() {
    if (busy) return;
    setPending(null);
    setError(null);
  }

  async function decide() {
    if (!pending || chosen === null) return;
    const { candidate: c, verdict } = pending;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/merchant-ops/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          verdict,
          survivorKey: c.survivorKey,
          absorbedKey: c.absorbedKey,
          evidenceTier: c.tier,
          evidenceSignal: c.signal,
          reason: chosen,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        // 409 (changed meanwhile) / 422 (no longer a candidate): the list is stale — refresh it under the dialog.
        if (res.status === 409 || res.status === 422) router.refresh();
        throw new Error(j.error ?? `Request failed (${res.status})`);
      }
      setOutcome(outcomeLine(verdict, c));
      setDecided((d) => new Set(d).add(keyOf(c)));
      setPending(null);
      router.refresh();
      // Focus lands on the outcome (the card that opened the dialog is gone).
      requestAnimationFrame(() => outcomeRef.current?.focus());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed");
    } finally {
      setBusy(false);
    }
  }

  const copy = pending ? dialogCopy(pending.verdict, pending.candidate) : null;

  return (
    <div className="flex flex-col gap-3">
      {outcome && (
        <p role="status" data-outcome ref={outcomeRef} tabIndex={-1}
          className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] px-3 py-2 text-xs text-[var(--text-primary)]">
          <CheckCircle2 size={14} className="shrink-0 text-[var(--accent-positive)]" aria-hidden /> {outcome}
        </p>
      )}
      {candidates.filter((c) => !decided.has(keyOf(c))).length === 0 ? empty : (
        <ul className="flex flex-col gap-3">
          {candidates.filter((c) => !decided.has(keyOf(c))).map((c) => (
            <CandidateCard key={keyOf(c)} candidate={c} actions={canDecide ? (
              <div className="flex flex-wrap gap-2" data-decision-actions>
                <GlassButton tone="meridian" size="sm" onClick={() => open(c, "MERGED")} aria-haspopup="dialog" className={ACTION}>
                  <GitMerge size={14} aria-hidden /> Merge
                </GlassButton>
                <GlassButton tone="neutral" size="sm" onClick={() => open(c, "DISMISSED")} aria-haspopup="dialog" className={ACTION}>
                  <X size={14} aria-hidden /> Not the same
                </GlassButton>
              </div>
            ) : null} />
          ))}
        </ul>
      )}
      {pending && copy && (
        <ConfirmDialog
          icon={pending.verdict === "MERGED" ? GitMerge : X}
          title={copy.title}
          message={<>
            <p>{copy.outcome}</p>
            {error && <p role="alert" className="mt-2 text-xs text-[var(--accent-negative)]">{error}</p>}
            <OperatorReasonField value={reason} onChange={setReason} disabled={busy}
              label="Reason (required) — recorded with this decision" />
          </>}
          confirmLabel={copy.confirmLabel}
          confirmTone={pending.verdict === "MERGED" ? "danger" : "meridian"}
          busy={busy}
          confirmDisabled={chosen === null}
          onConfirm={decide}
          onClose={close}
        />
      )}
    </div>
  );
}
