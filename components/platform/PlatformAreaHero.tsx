"use client";

/**
 * components/platform/PlatformAreaHero.tsx  (PO-2 — Platform HQ Editorial Convergence)
 *
 * The editorial lede that opens each Fourth Meridian HQ area's Overview — the
 * platform analogue of LiquidityHero / MembersHero. Its whole job is to make an
 * operator arriving in an area feel "this is the operating environment for the
 * company," not "an admin dashboard": one area name, the ONE question that area
 * answers, a plain framing sentence, and a quiet operator-context line.
 *
 * PRESENTATION ONLY — no fetch, no numbers. It fabricates no metrics (the
 * data-backed Figures live in the Blocks below it). It preserves operator
 * context by folding the grant access level into the context line — the same
 * information that used to live only in a toolbar badge. Each area answers a
 * DIFFERENT question (the PO-2 workspace-expectations contract), so the copy is
 * keyed by PlatformArea and exhaustive over the enum.
 */

import type { PlatformArea } from "@prisma/client";

interface AreaCopy {
  /** The eyebrow — the area's name. */
  eyebrow: string;
  /** The ONE question this area answers (the editorial headline). */
  question: string;
  /** A plain framing sentence — what the operator is looking at here. */
  lede: string;
}

const AREA_COPY: Record<PlatformArea, AreaCopy> = {
  PLATFORM_OPS: {
    eyebrow: "Platform Operations",
    question: "What is the health of Fourth Meridian?",
    lede: "The operational state of the platform — system health, jobs, providers, and recent activity, read from the operational ledgers.",
  },
  SECURITY_OPS: {
    eyebrow: "Security Operations",
    question: "Is Fourth Meridian secure?",
    lede: "The security posture of the platform — authentication signals, active sessions, access events, and anomalies.",
  },
  GROWTH_REVENUE: {
    eyebrow: "Growth & Revenue",
    question: "How is the platform growing?",
    lede: "How the platform is adopted — signups, access requests, active users, and the conversion funnel.",
  },
  CUSTOMER_SUCCESS: {
    eyebrow: "Customer Success",
    question: "How are customers doing?",
    lede: "The health of the people using Fourth Meridian — operational signals and account activity, never their financial data.",
  },
};

export function PlatformAreaHero({
  area,
  accessLevel,
}: {
  area: PlatformArea;
  /** The operator's grant level for this area (READ | WRITE) — the operator context. */
  accessLevel: string;
}) {
  const copy = AREA_COPY[area];

  return (
    <section>
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        {copy.eyebrow}
      </p>

      <h1 className="mt-2 max-w-prose text-2xl font-semibold leading-tight text-[var(--text-primary)] sm:text-3xl">
        {copy.question}
      </h1>

      <p className="mt-2.5 max-w-prose text-sm text-[var(--text-secondary)]">{copy.lede}</p>

      <p className="mt-2 text-[11px] text-[var(--text-faint)]">
        You&rsquo;re operating Fourth Meridian · {accessLevel} access
      </p>
    </section>
  );
}
