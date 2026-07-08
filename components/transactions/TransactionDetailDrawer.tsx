"use client";

/**
 * components/transactions/TransactionDetailDrawer.tsx
 *
 * TI5-3A — Transaction Detail drawer FOUNDATION. Proves the path:
 *   row click → ?transaction=<id> → fetch GET /api/transactions/[id] →
 *   loading → success / 404 / error → close → browser Back.
 *
 * Reuses the Atlas OverlaySurface primitive (portal, scrim, ESC/backdrop close,
 * focus trap, mobile sheet, scroll lock, a11y) — no new drawer framework. The
 * content is intentionally a minimal Summary; richer sections (Transaction
 * Intelligence, Merchant Intelligence, Investment Intelligence, Attachments, AI)
 * plug into the body later. Empty sections are never rendered.
 *
 * This component calls useTransactionDrawer (useSearchParams), so it must be
 * mounted under a <Suspense> boundary by its host.
 */

import { useEffect, useState } from "react";
import { OverlaySurface } from "@/components/atlas/OverlaySurface";
import type { TransactionDetail } from "@/types";
import { useTransactionDrawer } from "./useTransactionDrawer";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; detail: TransactionDetail }
  | { status: "notfound" }
  | { status: "error" };

function money(amount: number, currency: string | null): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency ?? "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}

export function TransactionDetailDrawer() {
  const { transactionId, close } = useTransactionDrawer();
  if (!transactionId) return null;
  return (
    <OverlaySurface open onClose={close} title="Transaction" intent="dialog" size="md">
      {/* key={id} remounts the fetcher per transaction, so its initial state is
          "loading" without a synchronous setState in the effect. */}
      <TransactionDetailFetcher key={transactionId} id={transactionId} />
    </OverlaySurface>
  );
}

function TransactionDetailFetcher({ id }: { id: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const ac = new AbortController();
    fetch(`/api/transactions/${id}`, { signal: ac.signal })
      .then(async (res) => {
        if (res.status === 404) return setState({ status: "notfound" });
        if (!res.ok) return setState({ status: "error" });
        const data = (await res.json()) as { transaction: TransactionDetail };
        setState({ status: "loaded", detail: data.transaction });
      })
      .catch((e: unknown) => {
        // Ignore aborts (drawer closed / id changed before the response landed).
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setState({ status: "error" });
        }
      });
    return () => ac.abort();
  }, [id]);

  return <TransactionDetailBody state={state} />;
}

function TransactionDetailBody({ state }: { state: LoadState }) {
  if (state.status === "loading") {
    return <p className="text-sm py-6 text-center" style={{ color: "var(--text-muted)" }}>Loading…</p>;
  }
  if (state.status === "notfound") {
    return <p className="text-sm py-6 text-center" style={{ color: "var(--text-muted)" }}>This transaction isn’t available.</p>;
  }
  if (state.status === "error") {
    return <p className="text-sm py-6 text-center" style={{ color: "var(--text-muted)" }}>Couldn’t load this transaction. Please try again.</p>;
  }

  // ── Summary (the only section today; future intelligence sections plug in
  //    here — do not render empty sections). ──────────────────────────────────
  const d = state.detail;
  return (
    <div className="space-y-1">
      <p className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
        {d.merchantDisplayName ?? d.merchant}
      </p>
      <p className="text-2xl font-bold tabular-nums" style={{ color: "var(--text-primary)" }}>
        {d.amount > 0 ? "+" : "−"}{money(Math.abs(d.amount), d.currency ?? null)}
      </p>
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>{d.date}</p>
    </div>
  );
}
