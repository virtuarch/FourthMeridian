/**
 * components/platform/platform-surface.tsx  (PM-1)
 *
 * PAGE-GRAIN presentation primitives for Platform Spaces.
 *
 * ── WHY THIS FILE EXISTS AND WHY IT IS NOT widget-kit ────────────────────────
 * `components/platform/widget-kit.tsx` is CARD grain: `PlatformWidgetCard`
 * frames ONE metric card with a 10px uppercase eyebrow. A consolidated
 * supporting surface is a different grain — it holds an entire operational
 * concern and groups its internals with space and one hairline instead of more
 * cards. Adding these to widget-kit was considered and is explicitly rejected by
 * docs/plans/Platform-Ops-Prototype-Production-Migration.md §9.
 *
 * ── THE FRAME RULE ───────────────────────────────────────────────────────────
 * ONE frame level. A `SectionSurface` is the only bordered box on the surface;
 * everything inside it is separated by whitespace and type weight, never by a
 * nested `Surface`/card. The migration doc §7 states it as "groups separated by
 * whitespace + one hairline, never a nested box", and `platform-surface.test.ts`
 * asserts it rather than trusting this comment.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────
 * The prototype's `parts.tsx` ships 21 pieces. Four are here. `BigStat`, `VRule`,
 * `KeyRow`, `PanelSection`, `StatusBadge`, `SeverityBadge`, `ScopeLine` and
 * `useNarrowViewport` are NOT, because nothing in PM-1 uses them and a primitive
 * with no consumer is a framework, not a extraction. The next slice that needs
 * one adds it, with its own repetition count.
 *
 * Every colour here is an existing custom property from app/globals.css. No raw
 * hex, no tailwind palette class (lib/atlas/palette-ratchet.test.ts enforces it),
 * and — see `StatusWord` — no way to spend colour without also spending a word.
 */

import type { ElementType, ReactNode } from "react";
import { Surface } from "@/components/atlas/Surface";

/**
 * A LARGE parent surface with its own titled header — the page-grain frame.
 *
 * The title sits at `text-base font-semibold`, an EXISTING Fourth Meridian type
 * tier (dialog titles, panel headers), one full step above the 10px uppercase
 * eyebrow that `PlatformWidgetCard` uses. That single step is the hierarchy a
 * flat grid of equal-weight cards cannot express: it says "this whole region is
 * one thing", which is the entire argument for consolidating five cards into
 * four groups.
 *
 * No `count` prop, no `actions` slot, no `id`/scroll-target: the prototype has
 * all three and PM-1 uses none of them.
 */
export function SectionSurface({
  icon: Icon,
  title,
  footnote,
  children,
}: {
  /** A faint scanning marker, never a badge. Optional — the title carries the identity. */
  icon?: ElementType;
  title: string;
  /** The surface's honesty line: what this surface does and does not claim. */
  footnote?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <Surface className="px-5 py-5 md:px-6 md:py-6">
        <header className="mb-6 flex flex-wrap items-center gap-2.5">
          {Icon && <Icon size={16} strokeWidth={1.75} className="text-[var(--text-muted)]" aria-hidden />}
          <h2 className="text-base font-semibold text-[var(--text-primary)]">{title}</h2>
        </header>
        {children}
        {footnote && (
          <p
            className="mt-6 border-t pt-4 text-[11px] leading-relaxed text-[var(--text-muted)]"
            style={{ borderColor: "var(--border-hairline)" }}
          >
            {footnote}
          </p>
        )}
      </Surface>
    </section>
  );
}

/**
 * The 10px uppercase eyebrow, doing the job it is actually good at: labelling a
 * GROUP INSIDE a surface rather than standing in for a section title.
 *
 * This is the demotion the migration doc's typography rule (§7) asks for — the
 * eyebrow stops being a heading and becomes what it always read as, a quiet
 * label found once and then ignored.
 */
export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{children}</span>
  );
}

/**
 * Value over qualifier — the line grammar of a consolidated read.
 *
 * The value is the fact; the qualifier is how we know it or what is true of it.
 * `qualifierTone` takes a CSS custom property so a line can carry the authority's
 * own bad news, but see `StatusWord`: the tone is never the only carrier — the
 * qualifier TEXT always names the state in words.
 *
 * Nothing is truncated. GROWTH-1's rule holds: every fact is on the surface, so
 * it reads identically to a mouse and to a finger. A `title`-attribute tooltip
 * would hide half the sentence from touch and from a screen reader.
 */
export function TwoLine({
  value,
  qualifier,
  qualifierTone,
}: {
  value: ReactNode;
  qualifier?: ReactNode;
  /** An existing CSS custom property, e.g. `var(--coral-400)`. Defaults to muted. */
  qualifierTone?: string;
}) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="text-[11px] break-words text-[var(--text-secondary)]">{value}</span>
      {qualifier != null && (
        <span className="text-[11px] break-words" style={{ color: qualifierTone ?? "var(--text-muted)" }}>
          {qualifier}
        </span>
      )}
    </span>
  );
}

/**
 * A status rendered as a WORD that happens to be coloured — never as a colour
 * that happens to mean something.
 *
 * The signature is the doctrine: `word` is required and `token` is only ever a
 * colour, so there is no way to spend urgency colour on this surface without
 * also spending a word. That survives greyscale, a colour-blind operator and a
 * screen reader, and it is why `platform-surface.test.ts` can assert the rule
 * structurally instead of by eyeballing a screenshot.
 *
 * URGENCY IS SATURATION, NOT DARKNESS. Callers must pass `--coral-400` for
 * danger and `--coral-300` for caution, following the ramp components/atlas/
 * tones.ts already ships. The deepest coral (`--coral-600`) measures 3.28:1 on
 * the dark surface — it fails WCAG AA for small text, which is exactly backwards
 * for the one signal an operator must never struggle to read (the finding is
 * recorded in incident-preview-view.ts and repeated here so the next caller does
 * not rediscover it).
 */
export function StatusWord({ word, token }: { word: string; token: string }) {
  return (
    <span className="text-sm font-medium" style={{ color: token }}>
      {word}
    </span>
  );
}

/**
 * Names the SYSTEM OF RECORD behind a number.
 *
 * This is the one primitive here that exists for a doctrinal reason rather than
 * a repetition count. A time or a count with no statement of where it came from
 * is what let "last tick" and "last recorded execution" get confused in the
 * prototype's first pass; on a consolidated surface, where four authorities'
 * answers sit side by side in one frame, an unattributed figure is worse still —
 * the reader cannot tell which system to go and ask.
 *
 * `source` is free text on purpose. The prototype typed it as a closed union of
 * prototype-shaped sources; in production the honest source is whichever module
 * or table actually answered, and that set grows with every slice.
 */
export function Provenance({ source, children }: { source: string; children?: ReactNode }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
      <span
        className="border px-1.5 font-mono text-[10px] text-[var(--text-muted)]"
        style={{ borderRadius: "var(--radius-xs)", paddingBlock: 1, borderColor: "var(--border-hairline)" }}
      >
        {source}
      </span>
      {children}
    </span>
  );
}
