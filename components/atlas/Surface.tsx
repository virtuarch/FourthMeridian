/**
 * components/atlas/Surface.tsx
 *
 * The "solid surfaces carry information" kit — the prototype's read-surface
 * design language (prototype components/Surface.tsx) brought into production, on
 * production tokens.
 *
 * The rule, mechanical enough to hold under pressure: anything you READ sits on
 * an opaque Surface; anything you ACT THROUGH is glass (GlassPanel/GlassButton).
 * Frosted glass under a number costs contrast and puts a moving, refracting
 * background behind the one thing that must be unambiguous. So numbers get a
 * solid-reading surface (--surface-inset over the solid page — no backdrop blur,
 * nothing moving behind the figure), hairline border, and a quiet elevation.
 *
 * Surface is deliberately not a "Card": no forced padding, no header slot, no
 * title prop — it's a material, and composition happens at the call site (Block
 * supplies the labelled-region pattern when you want one).
 */

import type { ReactNode } from "react";

export function Surface({
  children,
  className = "",
  tone = "raised",
  as: As = "div",
}: {
  children: ReactNode;
  className?: string;
  /** raised = default read surface; sunken = a quieter inset strip (e.g. Basis). */
  tone?: "raised" | "sunken";
  as?: "div" | "section" | "article" | "li";
}) {
  return (
    <As
      className={["rounded-[var(--radius-lg)] border border-[var(--border-hairline)]", className].join(" ")}
      style={{
        background: tone === "sunken" ? "rgba(255,255,255,.03)" : "var(--surface-inset)",
        boxShadow: tone === "sunken" ? undefined : "var(--shadow-e2)",
      }}
    >
      {children}
    </As>
  );
}

/**
 * A labelled region. The label is the quietest thing in the block — found once,
 * then ignored, never competing with the figure it describes. `id` makes it a
 * scroll target (scroll-mt clears the sticky header).
 */
export function Block({
  label,
  hint,
  action,
  children,
  className = "",
  id,
}: {
  label: string;
  hint?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={["flex flex-col", id ? "scroll-mt-20" : "", className].join(" ")}>
      {/* min-h keeps every Block header the SAME height whether its action is a
          button (e.g. a dropdown) or plain text, so two Blocks side by side line
          their content up rather than one starting lower than the other. */}
      <header className="mb-4 flex min-h-8 items-center justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{label}</h2>
          {hint}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/**
 * A figure. Tabular by construction so money never jitters and columns align.
 * `tone` signals real gain/loss ONLY (Design Language Law 7) — colour on a number
 * is a claim, so there is no brand tone.
 */
export function Figure({
  value,
  size = "figure",
  tone = "neutral",
  className = "",
}: {
  value: ReactNode;
  size?: "body" | "lede" | "title" | "figure" | "hero" | "hero-lg";
  tone?: "neutral" | "up" | "down" | "muted";
  className?: string;
}) {
  const sizeCls = {
    body: "text-sm",
    lede: "text-base",
    title: "text-lg",
    figure: "text-2xl",
    hero: "text-4xl",
    "hero-lg": "text-5xl",
  }[size];

  const toneCls = {
    neutral: "text-[var(--text-primary)]",
    up: "text-[var(--accent-positive)]",
    down: "text-[var(--accent-negative)]",
    muted: "text-[var(--text-muted)]",
  }[tone];

  const weight = size === "hero" || size === "hero-lg" ? "font-semibold" : "font-medium";

  return <span className={["tabular-nums tracking-tight", sizeCls, toneCls, weight, className].join(" ")}>{value}</span>;
}

/** A delta — always paired with its window. A percentage with no baseline is not
 *  a fact, it's a vibe. Tone follows the sign of the leading character. */
export function Delta({ text, window: win }: { text: string; window?: ReactNode }) {
  const dir = text.startsWith("+") || text.startsWith("↑") ? "up" : text.startsWith("−") || text.startsWith("-") || text.startsWith("↓") ? "down" : "muted";
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <Figure value={text} size="body" tone={dir} />
      {win && <span className="text-[11px] text-[var(--text-muted)]">{win}</span>}
    </span>
  );
}
