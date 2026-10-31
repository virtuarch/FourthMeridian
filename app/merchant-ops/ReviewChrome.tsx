/**
 * app/merchant-ops/ReviewChrome.tsx  (Merchant merge review — presentation)
 *
 * Hook-free building blocks of the review page: the header (Back link, title,
 * purpose), the summary strip, the empty state, and one candidate card. They
 * render only what they are given — the pending candidates come from
 * getPendingMergeCandidates on the server, the copy from ./review-model. The
 * card's decision controls arrive as the `actions` slot, which the client list
 * fills ONLY for a holder who can decide (UI-001: never a button that 403s).
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Surface } from "@/components/atlas/Surface";
import type { MerchantReviewFacts, PendingMergeCandidate } from "@/lib/transactions/merchant-merge-review";
import { BACK_HREF, BACK_LABEL, EMPTY, PURPOSE, READ_ONLY_LINE, TIER_META, plural, survivorRationale, type ReviewSummary } from "./review-model";

const EYEBROW = "text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]";

export function BackLink() {
  return (
    <Link href={BACK_HREF} data-back-link
      className="inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-xs)] text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-8">
      <ArrowLeft size={14} aria-hidden /> {BACK_LABEL}
    </Link>
  );
}

export function ReviewHeader() {
  return (
    <header className="flex flex-col gap-3">
      <BackLink />
      <div className="flex flex-col gap-2">
        <p className={EYEBROW}>Merchant Operations</p>
        <h1 className="text-xl font-semibold text-[var(--text-primary)]">Merchant merge review</h1>
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{PURPOSE.candidate}</p>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-3">
          <dt className={EYEBROW}>Merge</dt>
          <dd className="mt-1 leading-relaxed text-[var(--text-secondary)]">{PURPOSE.merge}</dd>
        </div>
        <div className="rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-3">
          <dt className={EYEBROW}>Not the same</dt>
          <dd className="mt-1 leading-relaxed text-[var(--text-secondary)]">{PURPOSE.dismiss}</dd>
        </div>
      </dl>
    </header>
  );
}

export function ReviewSummaryStrip({ summary, canDecide }: { summary: ReviewSummary; canDecide: boolean }) {
  return (
    <Surface tone="sunken" className="flex flex-col gap-2 p-4" as="section">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2" data-summary>
        <span className="flex items-baseline gap-1.5">
          <span className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">{summary.pending}</span>
          <span className="text-xs text-[var(--text-secondary)]">{`pending ${plural(summary.pending, "candidate", "candidates")}`}</span>
        </span>
        {summary.byTier.map((t) => (
          <span key={t.tier} className="flex items-baseline gap-1.5" data-tier-count={t.tier}>
            <span className="text-sm font-medium tabular-nums text-[var(--text-primary)]">{t.count}</span>
            <span className="text-xs text-[var(--text-muted)]">{t.label}</span>
          </span>
        ))}
      </div>
      <p className="text-xs text-[var(--text-muted)]" data-access-line>
        {canDecide ? "You can merge or dismiss. Every decision requires a reason and is audited." : READ_ONLY_LINE}
      </p>
    </Surface>
  );
}

export function EmptyReview() {
  return (
    <Surface className="flex flex-col items-center gap-2 px-4 py-10 text-center" as="section">
      <h2 className="text-sm font-medium text-[var(--text-primary)]">{EMPTY.title}</h2>
      <p className="max-w-md text-xs leading-relaxed text-[var(--text-muted)]">{EMPTY.body}</p>
      <BackLink />
    </Surface>
  );
}

function Side({ role, facts, note }: { role: "Keep" | "Absorb"; facts: MerchantReviewFacts; note?: string | null }) {
  return (
    <div className="min-w-0 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-3" data-side={role}>
      <p className={EYEBROW}>{role === "Keep" ? "Keep (survives)" : "Absorb (deleted after merge)"}</p>
      <p className="mt-1 break-words text-sm font-medium text-[var(--text-primary)]">{facts.displayName}</p>
      <p className="mt-1 text-xs tabular-nums text-[var(--text-secondary)]">
        {`${facts.aliasCount} ${plural(facts.aliasCount, "alias", "aliases")} · ${facts.transactionCount} ${plural(facts.transactionCount, "transaction", "transactions")} · ${facts.ruleCount} ${plural(facts.ruleCount, "rule", "rules")}`}
      </p>
      {note && <p className="mt-1 text-[11px] text-[var(--text-muted)]">{note}</p>}
    </div>
  );
}

export function CandidateCard({ candidate: c, actions }: { candidate: PendingMergeCandidate; actions?: ReactNode }) {
  const tier = TIER_META[c.tier];
  return (
    <Surface as="li" className="flex min-w-0 flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <span className="inline-flex w-fit items-center rounded-[var(--radius-xs)] border border-[var(--border-hairline)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-primary)]" data-tier={c.tier}>
          {tier.label}
        </span>
        <p className="text-[11px] text-[var(--text-muted)]">{tier.meaning}</p>
      </div>
      <p className="text-sm text-[var(--text-primary)]">{c.explanation}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Side role="Keep" facts={c.survivor} note={survivorRationale(c.tier)} />
        <Side role="Absorb" facts={c.absorbed} />
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">Counts span every tenant.</p>
      {actions}
    </Surface>
  );
}
