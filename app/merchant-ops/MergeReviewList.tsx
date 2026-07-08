"use client";

/**
 * app/merchant-ops/MergeReviewList.tsx  (MI2 S2 — merge review surface)
 *
 * The minimal client half of the review surface: renders each pending candidate
 * with its evidence + counts and two actions — Merge / Dismiss — that POST a
 * verdict to /api/merchant-ops/decide, then refresh. It carries ZERO merchant
 * logic: it never computes a merge, never resolves ids, never decides a survivor
 * (the server pre-selected it). It only orchestrates the two calls.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PendingMergeCandidate } from "@/lib/transactions/merchant-merge-review";

export function MergeReviewList({ candidates }: { candidates: PendingMergeCandidate[] }) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(c: PendingMergeCandidate, verdict: "MERGED" | "DISMISSED") {
    const rowKey = `${c.survivorKey}→${c.absorbedKey}`;
    setBusyKey(rowKey);
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
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Request failed (${res.status})`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed");
    } finally {
      setBusyKey(null);
    }
  }

  if (candidates.length === 0) return null;

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {candidates.map((c) => {
        const rowKey = `${c.survivorKey}→${c.absorbedKey}`;
        const busy = busyKey === rowKey;
        return (
          <div key={rowKey} className="rounded-lg border border-gray-200 p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700">{c.tier}</span>
              <span className="text-gray-800">{c.explanation}</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3 text-xs text-gray-600">
              <div>
                <div className="font-medium text-gray-800">Keep: {c.survivor.displayName}</div>
                <div>{c.survivor.aliasCount} alias · {c.survivor.transactionCount} txns · {c.survivor.ruleCount} rules</div>
              </div>
              <div>
                <div className="font-medium text-gray-800">Absorb: {c.absorbed.displayName}</div>
                <div>{c.absorbed.aliasCount} alias · {c.absorbed.transactionCount} txns · {c.absorbed.ruleCount} rules</div>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                disabled={busy}
                onClick={() => decide(c, "MERGED")}
                className="rounded bg-gray-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
              >
                {busy ? "Working…" : "Merge"}
              </button>
              <button
                disabled={busy}
                onClick={() => decide(c, "DISMISSED")}
                className="rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 disabled:opacity-50"
              >
                Not the same
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
