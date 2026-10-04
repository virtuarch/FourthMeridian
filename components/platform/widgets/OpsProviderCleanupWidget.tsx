"use client";

/**
 * components/platform/widgets/OpsProviderCleanupWidget.tsx
 *
 * WHAT PLAID STILL OWES US, AND WHY IT IS NOT THE SAME QUESTION AS "IS IT
 * DISCONNECTED".
 *
 * A failed `itemRemove` used to leave the item REVOKED and therefore invisible
 * to every `status: ACTIVE` work-list in the repository, while the Item kept
 * existing at Plaid, kept emitting webhooks and kept BILLING — that is what
 * stranded seven live Items on 2026-07-22. f339e57 made the obligation durable;
 * this widget makes it VISIBLE, so an operator does not have to remember to run
 * `npm run plaid:cleanup-orphans` to discover it.
 *
 * ⚠️ THE TWO STATES ARE RENDERED SIDE BY SIDE AND LABELLED, DELIBERATELY.
 *   "Product"  = PlaidItem.status (REVOKED) — what the customer sees.
 *   "Provider" = the newest revocation marker — what we still owe.
 * Showing only the first is what made the defect invisible for six weeks, and
 * reading the first as proof of the second is the vacuous check f339e57 fixed.
 *
 * Read-only metadata: item id (already the operator handle used by resync and
 * request-reauth), institution label, an opaque owner reference, timestamps,
 * counts, and the provider's own error code. NO access tokens, NO email, NO
 * financial content.
 *
 * Backed by GET /api/platform/platform-ops/provider-cleanup
 * (requirePlatformAccess PLATFORM_OPS READ). The Retry action POSTs to the same
 * route behind requireFreshPlatformAccess(…, "WRITE") and re-reads durable
 * state; this component never decides success itself.
 */

import { useState } from "react";
import { ShieldAlert, RotateCw, Check } from "lucide-react";
import { PlatformWidgetCard, WidgetMessage, useWidgetFetch, timeAgo, type PlatformSection } from "@/components/platform/widget-kit";
import type { PlatformProviderCleanupResponse, ProviderCleanupRetryResponse } from "@/app/api/platform/platform-ops/provider-cleanup/route";

function age(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function OpsProviderCleanupWidget({ section }: { section: PlatformSection }) {
  const { data: initial, loading, error } = useWidgetFetch<PlatformProviderCleanupResponse>(
    "/api/platform/platform-ops/provider-cleanup",
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Record<string, string>>({});
  /**
   * The post-action RE-READ. `useWidgetFetch` is load-once by design and is
   * shared by every Platform Ops widget, so it is NOT widened here just to give
   * this one a refresh — the override lives locally and the hook keeps its
   * contract. Rendering prefers the re-read when there is one.
   */
  const [reread, setReread] = useState<PlatformProviderCleanupResponse | null>(null);
  const data = reread ?? initial;

  async function rereadStatus() {
    const res = await fetch("/api/platform/platform-ops/provider-cleanup", { credentials: "same-origin" });
    if (res.ok) setReread((await res.json()) as PlatformProviderCleanupResponse);
  }

  async function retry(plaidItemId: string) {
    setBusy(plaidItemId);
    try {
      const res = await fetch("/api/platform/platform-ops/provider-cleanup", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ plaidItemId }),
      });
      const body = (await res.json().catch(() => null)) as ProviderCleanupRetryResponse | null;
      // ⚠️ THE SERVER'S `confirmed` IS THE VERDICT, read back off the durable
      // marker after the attempt. This component does not infer success from
      // anything — not from the HTTP status, and certainly not from the item
      // being REVOKED, which it already was before the retry.
      setOutcome((o) => ({
        ...o,
        [plaidItemId]: body?.confirmed ? "Confirmed" : body?.skipped === "ITEM_GONE" ? "Item gone" : "Still owed",
      }));
      await rereadStatus();
    } catch {
      setOutcome((o) => ({ ...o, [plaidItemId]: "Retry failed" }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <PlatformWidgetCard label={section.label} icon={ShieldAlert}>
      <WidgetMessage loading={loading} error={error} />
      {data && (
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[var(--text-muted)]">Provider cleanup owed</span>
            <span className={`text-right tabular-nums ${data.owedCount > 0 ? "text-[var(--accent-danger)]" : "text-[var(--text-primary)]"}`}>
              {data.owedCount}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[var(--text-muted)]">Oldest outstanding</span>
            <span className="text-right tabular-nums text-[var(--text-primary)]">{age(data.oldestOwedForHours)}</span>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[var(--text-muted)]">Confirmed removals</span>
            <span className="text-right tabular-nums text-[var(--text-primary)]">{data.confirmedCount}</span>
          </div>

          {/* ⚠️ THE ZERO STATE SAYS WHAT IT READ. "Nothing owed" over zero
              markers and "nothing owed" over 40 resolved ones are different
              operational facts, and a widget that renders them identically is
              how a broken reader looks healthy. */}
          {data.owedCount === 0 && (
            <p className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
              <Check size={13} aria-hidden className="text-[var(--accent-success)]" />
              Nothing owed — {data.markersRead} revocation marker{data.markersRead === 1 ? "" : "s"} read.
            </p>
          )}

          {data.owed.length > 0 && (
            <div className="flex flex-col gap-2 border-t border-[var(--border-hairline)] pt-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Awaiting confirmed removal at Plaid
              </p>
              {data.owed.map((o) => (
                <div key={o.plaidItemId} className="flex flex-col gap-1 rounded-lg border border-[var(--border-hairline)] p-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[var(--text-primary)]">{o.institution ?? "(unknown institution)"}</span>
                    <span className="text-[11px] tabular-nums text-[var(--text-muted)]">owner …{o.ownerRef}</span>
                  </div>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-muted)]">
                    {/* The distinction, in the UI, in words. */}
                    <span>Product: <span className="text-[var(--text-primary)]">{o.itemGone ? "item deleted" : o.productStatus ?? "—"}</span></span>
                    <span>Provider: <span className="text-[var(--accent-danger)]">UNCONFIRMED</span></span>
                    <span>owed {age(o.owedForHours)} ({timeAgo(o.owedSinceISO)} ago)</span>
                    <span>{o.attemptCount} attempt{o.attemptCount === 1 ? "" : "s"}</span>
                    {o.latestErrorCode && <span>last code <span className="text-[var(--text-primary)]">{o.latestErrorCode}</span></span>}
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-0.5">
                    <span className="font-mono text-[10px] text-[var(--text-muted)]">{o.plaidItemId}</span>
                    {!o.itemGone && (
                      <button
                        type="button"
                        onClick={() => retry(o.plaidItemId)}
                        disabled={busy === o.plaidItemId}
                        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--text-primary)] disabled:opacity-50"
                      >
                        <RotateCw size={11} /> {busy === o.plaidItemId ? "Retrying…" : "Retry cleanup"}
                      </button>
                    )}
                    {outcome[o.plaidItemId] && (
                      <span className="text-[11px] text-[var(--text-muted)]">{outcome[o.plaidItemId]}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </PlatformWidgetCard>
  );
}
