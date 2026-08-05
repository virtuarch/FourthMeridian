"use client";

/**
 * components/transactions/TransactionDetailDrawer.tsx
 *
 * The shared Transaction Detail surface. Proves the path:
 *   row click → ?transaction=<id> → fetch GET /api/transactions/[id] →
 *   loading → success / 404 / error → close → browser Back.
 *
 * Editorial convergence: the detail is a CONTEXTUAL surface, not a decision — you
 * inspect a transaction while the ledger stays put behind it — so it is the Atlas
 * RightPanel (edge-docked, workspace preserved) rather than the centered
 * OverlaySurface modal it began as. The body is unchanged: an editorial headline
 * (the amount as a Figure + flow/pending/currency chips) over the pure, tested
 * section projection (lib/transactions/detail-sections.ts, rendered by
 * TransactionDetailContent) — facts, account, classification, provenance,
 * relationships. Empty sections are never rendered.
 *
 * TX-3.4 completes the find → inspect → ACT loop: the correction surface for the
 * pre-existing POST /api/transactions/[id]/correct (which had shipped with no UI).
 * The endpoint returns the FRESH TransactionDetail, so a correction updates this
 * panel in place with no refetch — and notifies the sibling explorer list to re-ask
 * its question, since a recategorized row may no longer match the active filters.
 *
 * The AI slot is a RESERVED FUTURE region — no AI call, no fabricated explanation.
 * It only links into the existing AI destination; per-transaction explanations are
 * a later backend initiative (v2.6). See the roadmap in docs/audits.
 *
 * This component calls useTransactionDrawer (useSearchParams), so it must be
 * mounted under a <Suspense> boundary by its host (DashboardChrome).
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import { Figure } from "@/components/atlas/Surface";
import type { TransactionDetail } from "@/types";
import { useTransactionDrawer } from "./useTransactionDrawer";
import { TransactionDetailContent } from "./TransactionDetailContent";
import { TransactionCorrection } from "./TransactionCorrection";
import { describeRowNature } from "@/lib/transactions/flow-presentation";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; detail: TransactionDetail }
  | { status: "notfound" }
  | { status: "error" };

// Client-mount detection via the repo's hydration-safe idiom (see useAtlasLiquid):
// the server + first hydration render read `false`, then it flips to `true` — no
// setState-in-effect. Snapshots are module-level so the subscription never churns.
const subscribeNoop = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

// ── local formatters (presentation only — the DTO carries the numbers) ──────────
function money(amount: number, currency: string | null): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency ?? "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}

export function TransactionDetailDrawer() {
  const { transactionId, close } = useTransactionDrawer();

  // Client-mount gate. On a `?transaction=<id>` deep link the panel would be open on
  // the very first render; Panel portals to document.body on the client but renders
  // null on the server, so opening during hydration mismatches. Holding `open` false
  // until mounted makes the first client render match the server (both null), then it
  // flips true — which also gives the deep link a clean slide-in. (OverlaySurface
  // guards the same way; Panel's usePresence does not, so its consumer does it here.)
  const ready = useSyncExternalStore(subscribeNoop, clientReady, serverReady);

  // Hold the last id through the panel's exit animation so the content doesn't blank
  // mid-slide (the prototype TxnDrawer pattern). A React-documented store-from-render.
  const [held, setHeld] = useState<string | null>(null);
  if (transactionId && transactionId !== held) setHeld(transactionId);
  const id = transactionId ?? held;

  return (
    <RightPanel open={ready && transactionId != null} onClose={close} ariaLabel="Transaction detail">
      {/* key={id} remounts the fetcher per transaction, so its initial state is
          "loading" without a synchronous setState in the effect. */}
      {id && <TransactionDetailFetcher key={id} id={id} />}
    </RightPanel>
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

  const detail = state.status === "loaded" ? state.detail : null;

  return (
    <>
      {/* v2.6-TRUTH-7 — the eyebrow is the canonical nature, not the provider
          category string. It read "INCOME" directly above a chip saying "Issuer
          credit", which is the loudest place in the drawer to contradict
          yourself. The provider's category is still shown, labelled as itself,
          in the Summary section below. */}
      <PanelHeader
        eyebrow={detail ? describeRowNature({
          flowType:      detail.flowType ?? null,
          incomeSubtype: detail.incomeSubtype ?? null,
    transferMaturity: detail.transferMaturity ?? null,
          amount:        detail.amount,
          hasOwnedCounterparty: detail.counterpartyAccountId != null,
        }).label : undefined}
        title={detail ? (detail.merchantDisplayName ?? detail.merchant) : "Transaction"}
      />
      <PanelContent>
        {detail ? (
          <div className="space-y-5">
            <TransactionHeadline detail={detail} />
            {/* Structured, display-only sections — Summary / Account / Transaction
                Intelligence / Relationships / Provenance / Reporting. Projection +
                wording live in the pure lib/transactions/detail-sections.ts. */}
            <TransactionDetailContent detail={detail} />
            {/* ACT. The endpoint is the only authority for what the transaction now
                is: we render whatever detail it hands back, never a local guess. */}
            <TransactionCorrection
              detail={detail}
              onCorrected={(fresh) => setState({ status: "loaded", detail: fresh })}
            />
            <AiExplanationSlot />
          </div>
        ) : (
          <TransactionDetailBody state={state} />
        )}
      </PanelContent>
    </>
  );
}

/** The editorial headline — the amount as a Figure, with a nature/pending/currency
 *  chip row.
 *
 *  v2.6-TRUTH-7 — the chip is the canonical row NATURE, not `humanize(flowType)`.
 *  Four live rows the income authority had already classified ISSUER_CREDIT (a
 *  Microsoft rebate, an Uber credit, a HungerStation credit, an EasyTime credit,
 *  all on a CREDIT CARD) read "Income" here because this drawer never consulted
 *  it. Tone follows the same authority: a refund and an issuer credit put back
 *  money you already spent, so they are neutral, not green (Design Language
 *  Law 7 — the same reason a transfer is neutral). */
function TransactionHeadline({ detail }: { detail: TransactionDetail }) {
  const nature = describeRowNature({
    flowType:      detail.flowType ?? null,
    incomeSubtype: detail.incomeSubtype ?? null,
    transferMaturity: detail.transferMaturity ?? null,
    amount:        detail.amount,
    hasOwnedCounterparty: detail.counterpartyAccountId != null,
  });
  const sign = nature.tone === "neutral" ? "" : nature.tone === "positive" ? "+" : "−";
  return (
    <div className="space-y-3">
      <Figure
        value={`${sign}${money(Math.abs(detail.amount), detail.currency ?? null)}`}
        size="figure"
        tone={nature.tone === "positive" ? "up" : "neutral"}
      />
      <div className="flex flex-wrap gap-2">
        <Chip>{nature.label}</Chip>
        {detail.pending && <Chip>Pending</Chip>}
        {detail.currency && detail.currency !== "USD" && <Chip>{detail.currency}</Chip>}
      </div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="text-xs px-2 py-0.5 rounded-full"
      style={{ background: "var(--surface-inset)", color: "var(--text-secondary)" }}
    >
      {children}
    </span>
  );
}

/**
 * Reserved future slot — an "Ask AI about this transaction" affordance. It makes
 * NO AI call and fabricates NO explanation; it only links into the existing AI
 * destination. Per-transaction grounded explanations are a later backend
 * initiative (v2.6): when that lands, this slot lights up in place.
 */
function AiExplanationSlot() {
  return (
    <section aria-label="Ask AI">
      <h3 className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: "var(--text-faint)" }}>
        Ask AI
      </h3>
      <div
        className="rounded-[var(--radius-lg)] border border-dashed p-4"
        style={{ borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
            style={{ background: "var(--surface-hover)" }}
          >
            <Sparkles size={13} style={{ color: "var(--text-muted)" }} />
          </span>
          <div className="min-w-0">
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
              Ask about this transaction — where it fits, why it’s classified this way, and what changed.
            </p>
            <Link
              href="/dashboard/analyze"
              className="mt-2 inline-block text-xs font-medium text-[var(--meridian-400)] hover:underline"
            >
              Open AI →
            </Link>
            <p className="mt-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
              Per-transaction explanations arrive in a future update.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function TransactionDetailBody({ state }: { state: LoadState }) {
  if (state.status === "loading") {
    return <p className="text-sm py-6 text-center" style={{ color: "var(--text-muted)" }}>Loading…</p>;
  }
  if (state.status === "notfound") {
    return <p className="text-sm py-6 text-center" style={{ color: "var(--text-muted)" }}>This transaction isn’t available.</p>;
  }
  // status === "error"
  return <p className="text-sm py-6 text-center" style={{ color: "var(--text-muted)" }}>Couldn’t load this transaction. Please try again.</p>;
}
