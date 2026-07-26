/**
 * components/platform/platform-surface.tsx  (PM-1 · extended by S2)
 *
 * THE SHARED PRESENTATION VOCABULARY for Platform Spaces — the prototype's
 * `parts.tsx` grammar, on production tokens.
 *
 * ── WHY THIS FILE EXISTS AND WHY IT IS NOT widget-kit ────────────────────────
 * `components/platform/widget-kit.tsx` is CARD grain: `PlatformWidgetCard`
 * frames ONE metric card with a 10px uppercase eyebrow. A consolidated
 * supporting surface is a different grain — it holds an entire operational
 * concern and groups its internals with space and one hairline instead of more
 * cards. Adding these to widget-kit was considered and is explicitly rejected by
 * docs/plans/Platform-Ops-Prototype-Production-Migration.md §9.
 *
 * ── THE AUTHORITY RULE ───────────────────────────────────────────────────────
 * The prototype (`prototype/prototype-ops-control-plane/parts.tsx`) is the UI
 * authority; production is the DATA authority. Spacing, type scale, weight and
 * structure here are the prototype's, copied rather than re-judged. Only four
 * classes of deviation are permitted, and each one is annotated where it occurs:
 *
 *   TOKENS        raw hex / rgba() in the prototype becomes an existing custom
 *                 property from app/globals.css (or a `color-mix` of one).
 *   RESPONSIVE    `useNarrowViewport` is NOT ported. The prototype needed it only
 *                 because a gitignored tree is invisible to Tailwind v4 content
 *                 detection, so `hidden md:block` never generated. Production is
 *                 scanned; every collapse is a `md:` variant.
 *   ACCESSIBILITY colour never travels alone, decorative marks are `aria-hidden`,
 *                 and a chart carries an accessible summary.
 *   PURITY        no fetching, no clock read. A primitive that needs "now" takes
 *                 it as a prop.
 *
 * ── THE FRAME RULE ───────────────────────────────────────────────────────────
 * ONE frame level per surface. A `SectionSurface` is the only bordered box on a
 * page surface; everything inside it is separated by whitespace and type weight,
 * never by a nested `Surface`/card. `PanelSection` is the deliberate exception
 * and it lives on a DIFFERENT plane — inside a `RightPanel`, never inside a
 * `SectionSurface`. `platform-surface.test.ts` asserts the rule rather than
 * trusting this comment.
 *
 * ── THE SEMANTIC RULE ────────────────────────────────────────────────────────
 * HEALTH owns colour. It is OBSERVED, from the JobRun ledger.
 * POLICY is quiet and neutral. It is DECLARED, by an operator.
 * An undeclared policy renders NOTHING.
 *
 * ── COLOUR ───────────────────────────────────────────────────────────────────
 * Every colour is an existing custom property. No raw hex, no tailwind palette
 * class (lib/atlas/palette-ratchet.test.ts enforces it), and — see `StatusWord`
 * and `StatusBadge` — no way to spend colour without also spending a word.
 *
 * URGENCY IS SATURATION, NOT DARKNESS. `--coral-400` is danger and `--coral-300`
 * is caution; `--coral-600` measures 3.28:1 on the dark surface and FAILS WCAG AA
 * for small text, which is exactly backwards for the one signal an operator must
 * never struggle to read.
 */

import type { ElementType, ReactNode } from "react";
import { Info } from "lucide-react";
import { Surface, Figure } from "@/components/atlas/Surface";
import {
  statusLabel,
  statusTone,
  type StatusTone,
} from "@/components/platform/widgets/job-health-format";
import type { JobHealthStatus } from "@/lib/jobs/health";

// ── Health: observed, and the only axis allowed to carry colour ───────────────

/**
 * The status vocabulary is NOT re-declared here.
 *
 * The prototype ships `StatusTone`, `statusTone()` and `statusLabel()` in
 * `parts.tsx`. Production already shipped all three — identical tones, identical
 * labels — in `widgets/job-health-format.ts`, keyed off the real `JobHealthStatus`
 * union from `lib/jobs/health.ts`. Porting the prototype's copies would create a
 * SECOND opinion about what "overdue" means, which is the one thing a migration
 * must not do. They are re-exported so a consuming surface can import the whole
 * vocabulary from one place, but there is exactly one implementation.
 *
 * (`job-health-format.ts` type-imports `lib/jobs/health`, so nothing server-side
 * is pulled into a client bundle by this edge.)
 */
export { statusLabel, statusTone };
export type { StatusTone, JobHealthStatus };

/**
 * Tone → colour. The one genuinely new thing in the health vocabulary, and the
 * only place a tone becomes a pixel.
 *
 * TOKEN SUBSTITUTIONS (the prototype named tokens that do not exist here):
 *   --success-400 → --emerald-400   (identical value, #34D399)
 *   --warning-400 → --accent-warning (identical value, #FBBF24)
 *   --danger-400  → --coral-400     (production's danger ramp; the accessible
 *                                    end of it — see the header note)
 */
export const TONE_COLOR: Record<StatusTone, string> = {
  ok: "var(--emerald-400)",
  info: "var(--meridian-400)",
  warn: "var(--accent-warning)",
  bad: "var(--coral-400)",
  muted: "var(--text-muted)",
};

/**
 * Dot + WORD, both in the status colour.
 *
 * The signature is the doctrine: the only input is a `JobHealthStatus`, and both
 * the colour and the word are derived from it by the same authority — so there is
 * no way to render this badge coloured and wordless. The dot is decorative and
 * `aria-hidden`; the word is the accessible content.
 */
export function StatusBadge({ status }: { status: JobHealthStatus }) {
  const color = TONE_COLOR[statusTone(status)];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" style={{ color }}>
      <span aria-hidden className="rounded-full" style={{ width: 6, height: 6, background: color }} />
      <span className="text-xs font-medium">{statusLabel(status)}</span>
    </span>
  );
}

// ── Policy: declared, and deliberately colourless ─────────────────────────────

/**
 * A neutral outlined pill in SENTENCE case. Quiet is the point: a policy is a
 * state label, not an alarm. Only an indefinite hold (`off`) is allowed a faint
 * brass tint, because it is the one policy an operator should notice while
 * scanning past — and even then the tint sits on a word, never alone.
 *
 * TOKEN SUBSTITUTION: `rgba(201,155,60,.30)` → `color-mix(--brass-300 30%)`.
 */
export function PolicyChip({ label, tone }: { label: string; tone: "hold" | "off" | "skip" }) {
  const style =
    tone === "off"
      ? { color: "var(--brass-300)", borderColor: "color-mix(in srgb, var(--brass-300) 30%, transparent)" }
      : { color: "var(--text-secondary)", borderColor: "var(--border-hairline-strong)" };
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-[var(--radius-sm)] border px-2 text-[11px] font-medium"
      style={{ ...style, paddingBlock: 2 }}
    >
      {label}
    </span>
  );
}

/**
 * A value Fourth Meridian does not currently observe.
 *
 * The single most important honesty primitive in the set. "No revenue rows" is
 * NOT `$0`; "no findings recorded" is NOT "secure"; "never observed" is NOT
 * "healthy". Each of those substitutions is a lie the layout would tell for free,
 * so unobserved values render through here — an em-dash plus the REASON, never a
 * zero and never a colour. There is no tone prop and no default reason: an
 * unexplained gap is not an improvement on a wrong number.
 */
export function Unavailable({ reason }: { reason: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-[var(--text-muted)]">—</span>
      <span className="text-[10px] text-[var(--text-faint)]">{reason}</span>
    </span>
  );
}

// ── Provenance: where a value comes from ──────────────────────────────────────

/**
 * Names the SYSTEM OF RECORD behind a value the operator cannot edit here.
 *
 * A time or a count with no statement of where it came from is what let "last
 * tick" and "last recorded execution" get confused in the prototype's first pass;
 * on a consolidated surface, where four authorities' answers sit side by side in
 * one frame, an unattributed figure is worse still — the reader cannot tell which
 * system to go and ask.
 *
 * The chip is faintly tinted with the INFORMATIONAL accent so it reads as a
 * reference rather than a verdict. The one exception is the literal string
 * `"no authority"`, which is not a system of record and must not borrow the tint
 * that means "this came from somewhere real" — it renders neutral, the same
 * honesty move as `Unavailable`.
 *
 * `source` is free text on purpose. The prototype typed it as a closed union of
 * prototype-shaped sources; in production the honest source is whichever module
 * or table actually answered, and that set grows with every slice.
 *
 * TOKEN SUBSTITUTIONS: `rgba(125,168,255,.20)` → `color-mix(--meridian-400 20%)`,
 * `rgba(59,130,246,.07)` → `color-mix(--meridian-500 7%)`.
 */
export const NO_AUTHORITY = "no authority";

export function Provenance({ source, children }: { source: string; children?: ReactNode }) {
  const unattributed = source === NO_AUTHORITY;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
      <span
        className="border px-1.5 font-mono text-[10px]"
        style={{
          borderRadius: "var(--radius-xs)",
          paddingBlock: 1,
          ...(unattributed
            ? { borderColor: "var(--border-hairline)", background: "transparent", color: "var(--text-faint)" }
            : {
                borderColor: "color-mix(in srgb, var(--meridian-400) 20%, transparent)",
                background: "color-mix(in srgb, var(--meridian-500) 7%, transparent)",
                color: "var(--meridian-400)",
              }),
        }}
      >
        {source}
      </span>
      {children}
    </span>
  );
}

// ── Surface / grouping primitives ─────────────────────────────────────────────

/**
 * A LARGE parent surface with its own titled header — the page-grain frame. One
 * of these holds an entire operational concern, and its internals are grouped
 * with rules and space instead of more cards.
 *
 * The title sits at `text-base font-semibold`, an EXISTING Fourth Meridian type
 * tier (dialog titles, panel headers), one full step above the 10px uppercase
 * eyebrow `PlatformWidgetCard` uses. That single step is most of the hierarchy a
 * flat grid of equal-weight cards cannot express.
 *
 * `icon` is OPTIONAL here where the prototype requires it — the title carries the
 * identity, and PM-1's health surface ships without one. Everything else matches:
 * `count` (Jobs), `actions` (Scheduler's policy note, Jobs' toolbar), `id` (the
 * rail's scroll targets) and `footnote` (the surface's honesty line).
 */
export function SectionSurface({
  icon: Icon,
  title,
  count,
  actions,
  footnote,
  children,
  id,
}: {
  /** A faint scanning marker, never a badge. Optional — the title carries the identity. */
  icon?: ElementType;
  title: string;
  /** Row/entity count, rendered as a quiet pill beside the title. */
  count?: number;
  /** Toolbar or one-line note, right-aligned in the header. */
  actions?: ReactNode;
  /** The surface's honesty line: what this surface does and does not claim. */
  footnote?: ReactNode;
  children: ReactNode;
  /** Scroll target for the rail. `scroll-mt` clears the sticky header. */
  id?: string;
}) {
  return (
    <section id={id} className={id ? "scroll-mt-20" : undefined}>
      <Surface className="px-5 py-5 md:px-6 md:py-6">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            {Icon && <Icon size={16} strokeWidth={1.75} className="text-[var(--text-muted)]" aria-hidden />}
            <h2 className="text-base font-semibold text-[var(--text-primary)]">{title}</h2>
            {count != null && (
              <span
                className="rounded-full px-2 text-[11px] font-medium text-[var(--text-secondary)]"
                style={{
                  background: "var(--surface-hover)",
                  border: "1px solid var(--border-hairline)",
                  paddingBlock: 1,
                }}
              >
                {count}
              </span>
            )}
          </div>
          {actions}
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
 * `hint` is the prototype's supplementary explanation — never a fact that has
 * nowhere else to be read, only the sentence that stops a figure being misread.
 * It is exposed to assistive technology through `aria-label` as well as `title`,
 * so it is not literally hover-only; the mouse tooltip is the same convention
 * `OpsUsersWidget` already ships.
 */
export function GroupLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{children}</span>
      {hint && (
        <span
          role="img"
          aria-label={hint}
          title={hint}
          className="inline-flex text-[var(--text-faint)]"
          style={{ cursor: "help" }}
        >
          <Info size={11} strokeWidth={2} aria-hidden />
        </span>
      )}
    </div>
  );
}

/**
 * A headline operational figure with its qualifier and its DERIVATION.
 *
 * The third line is the one that matters: a time with no statement of where it
 * came from is what let "last tick" and "last recorded execution" get confused in
 * the first place. `derivation` is `ReactNode` so a caller can hand it a
 * `Provenance` chip instead of prose.
 *
 * CONSUMER: the Scheduler surface (Observed | Expected).
 */
export function BigStat({
  label,
  value,
  qualifier,
  derivation,
  hint,
}: {
  label: string;
  value: ReactNode;
  /** The one-line reading of the figure — "3h ago · UTC". */
  qualifier?: string;
  /** Where the figure came from. Prose or a `Provenance` chip. */
  derivation?: ReactNode;
  /** Supplementary explanation, surfaced on the group label. */
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <GroupLabel hint={hint}>{label}</GroupLabel>
      <Figure value={value} size="figure" />
      {qualifier && <span className="text-[11px] text-[var(--text-secondary)]">{qualifier}</span>}
      {derivation && <span className="text-[10px] leading-relaxed text-[var(--text-faint)]">{derivation}</span>}
    </div>
  );
}

/**
 * A vertical hairline — the only separator used between groups inside a surface.
 * Cheaper than a border on every child, and it never boxes anything.
 *
 * RESPONSIVE DEVIATION. The prototype hides this with a `hidden` PROP driven by
 * `useNarrowViewport`, because its mockup was a 400px frame inside a wide
 * viewport and a media query would have left three columns side by side in a
 * "phone". Production has no such frame: the rule collapses with the columns at
 * the real `md` breakpoint, by class. There is no `hidden` prop and no viewport
 * hook — a JS read here would make the component impure and would fork the
 * breakpoint away from the grid it is separating.
 */
export function VRule() {
  return (
    <span
      aria-hidden
      className="hidden w-px self-stretch md:block"
      style={{ background: "var(--border-hairline)" }}
    />
  );
}

/**
 * Value over qualifier — the grammar of every table cell that carries a time, so
 * a column scans at one glance and resolves precisely on a second look.
 *
 * `tabular-nums` on the value is load-bearing: it is what makes a column of
 * timestamps line up. The qualifier is the quieter second line.
 *
 * Nothing is truncated, where the prototype truncates. GROWTH-1's rule holds:
 * every fact is on the surface, so it reads identically to a mouse and to a
 * finger. Truncation with no tooltip destroys the fact; truncation WITH a tooltip
 * hides it from touch and from a screen reader. Long values wrap instead.
 *
 * `qualifierTone` is additive and defaults to the prototype's muted — see
 * `StatusWord`: a tone is never the only carrier, the qualifier TEXT always names
 * the state in words.
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
      <span className="text-xs tabular-nums break-words text-[var(--text-primary)]">{value}</span>
      {qualifier != null && (
        <span className="text-[11px] break-words" style={{ color: qualifierTone ?? "var(--text-muted)" }}>
          {qualifier}
        </span>
      )}
    </span>
  );
}

/**
 * Label left, value right — the detail panel's whole grammar. No box.
 *
 * CONSUMER: the Job detail panel (Policy · Health · Recent executions · Metadata).
 */
export function KeyRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 text-xs text-[var(--text-secondary)]">{label}</span>
      <span className="min-w-0 text-right text-xs tabular-nums text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

/**
 * One section INSIDE a detail panel. A single quiet surface, generous padding,
 * and NO inner boxes — every row is a `KeyRow` on the same plane.
 *
 * This is the one primitive here that renders its own `Surface`, and it does not
 * break the frame rule because it lives on a different plane: inside a
 * `RightPanel`, never inside a `SectionSurface`. Nesting one in the other is the
 * box-in-a-box the consolidation exists to remove.
 *
 * CONSUMER: the Job detail panel.
 */
export function PanelSection({
  title,
  action,
  children,
}: {
  title: string;
  /** A single quiet control or note, right-aligned in the section header. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Surface className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center justify-between gap-3" style={{ minHeight: 24 }}>
        <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</h3>
        {action}
      </div>
      {children}
    </Surface>
  );
}

/**
 * A status rendered as a WORD that happens to be coloured — never as a colour
 * that happens to mean something.
 *
 * Where `StatusBadge` renders the closed `JobHealthStatus` vocabulary, this
 * renders a surface's own one-line verdict ("1 stale", "3 of 4 healthy",
 * "Nominal"). The signature is the doctrine: `word` is required and `token` is
 * only ever a colour, so there is no way to spend urgency colour on this surface
 * without also spending a word. That survives greyscale, a colour-blind operator
 * and a screen reader.
 *
 * Callers pass `--coral-400` for danger and `--coral-300` for caution — see the
 * file header for why the deeper corals are forbidden.
 *
 * CONSUMER: the Platform health surface (each group's headline).
 */
export function StatusWord({ word, token }: { word: string; token: string }) {
  return (
    <span className="text-sm font-medium" style={{ color: token }}>
      {word}
    </span>
  );
}

// ── Chart 1 · execution strip ─────────────────────────────────────────────────

/**
 * One EQUAL-HEIGHT mark per recent run, oldest left. Answers exactly one question
 * — "did the last N runs succeed, and did the deployment change part way
 * through?" — and nothing else.
 *
 * Equal heights because height would encode a second variable nobody asked
 * about; colour already carries the outcome. The dashed rule is the deployment
 * boundary, free from OPS-2B′'s `deploymentSha`.
 *
 * NEVER COLOUR-ONLY: the strip is a `role="img"` with an accessible label that
 * states the counts in words, and the per-mark `title` names each run's outcome.
 * A sighted-and-colour-blind operator reads the same sentence a screen reader
 * does. Pure: the caller supplies the runs, in ledger order (newest first).
 *
 * TOKEN SUBSTITUTION: `rgba(52,211,153,.42)` → `color-mix(--emerald-400 42%)`.
 * The succeeded mark is deliberately quieter than `TONE_COLOR.ok`: success is the
 * background against which a failure must stand out.
 *
 * CONSUMER: the Job detail panel (Recent executions).
 */
export function ExecutionStrip({
  runs,
}: {
  /** Newest first, as the JobRun ledger returns them. */
  runs: Array<{ status: "succeeded" | "failed" | "running"; deploymentSha: string }>;
}) {
  const ordered = [...runs].reverse();
  const flip = ordered.findIndex((r, i) => i > 0 && ordered[i - 1].deploymentSha !== r.deploymentSha);
  const fill = (s: string) =>
    s === "failed"
      ? TONE_COLOR.bad
      : s === "running"
        ? TONE_COLOR.info
        : "color-mix(in srgb, var(--emerald-400) 42%, transparent)";

  const failed = ordered.filter((r) => r.status === "failed").length;
  const running = ordered.filter((r) => r.status === "running").length;
  const succeeded = ordered.length - failed - running;
  const summary =
    `${ordered.length} recent runs: ${succeeded} succeeded, ${failed} failed` +
    (running > 0 ? `, ${running} running` : "") +
    (flip > 0 ? " · deployment changed part way through" : "");

  return (
    <div className="flex flex-col gap-2">
      {flip > 0 && (
        <div className="relative" style={{ height: 12 }}>
          <span
            className="absolute text-[10px] text-[var(--text-muted)]"
            style={{ left: `${(flip / ordered.length) * 100}%`, transform: "translateX(-50%)" }}
          >
            Deployment
          </span>
        </div>
      )}
      <div role="img" aria-label={summary} className="relative flex items-stretch" style={{ gap: 3, height: 26 }}>
        {ordered.map((r, i) => (
          <span
            key={i}
            className="flex-1"
            title={`${r.status} · ${r.deploymentSha}`}
            style={{ background: fill(r.status), borderRadius: 2 }}
          />
        ))}
        {flip > 0 && (
          <span
            aria-hidden
            className="absolute inset-y-0"
            style={{
              left: `${(flip / ordered.length) * 100}%`,
              borderLeft: "1px dashed var(--border-hairline-strong)",
            }}
          />
        )}
      </div>
      <div className="flex justify-between text-[10px] text-[var(--text-muted)]">
        <span>{ordered.length} runs ago</span>
        <span>now</span>
      </div>
    </div>
  );
}

// ── Chart 2 · runtime trend ───────────────────────────────────────────────────

/** Below this many observed points there is no trend to draw, only a shape. */
export const RUNTIME_TREND_MIN_POINTS = 5;

/**
 * Duration over the last N runs, with the axis labelled so the line means
 * something.
 *
 * REFUSES to draw below five observed points — and says why, rather than
 * rendering an empty box that reads as "nothing wrong". Deliberately NOT a
 * distribution: at n≈12 there is no distribution, and a histogram there is
 * decoration pretending to be analysis.
 *
 * `values` may contain nulls (a run with no recorded duration); they are dropped,
 * never zeroed. `format` is injected so the primitive holds no opinion about
 * units — the caller passes `fmtDuration` from `job-health-format`.
 *
 * TOKEN SUBSTITUTION: `rgba(52,211,153,.65)` → `color-mix(--emerald-400 65%)`.
 *
 * CONSUMER: the Job detail panel (Runtime).
 */
export function RuntimeTrend({
  values,
  format,
}: {
  /** Newest first. Nulls are unrecorded durations and are dropped, not zeroed. */
  values: Array<number | null>;
  format: (ms: number | null) => string;
}) {
  const pts = values.filter((v): v is number => v != null);
  if (pts.length < RUNTIME_TREND_MIN_POINTS) {
    return (
      <p className="text-[11px] text-[var(--text-muted)]">
        Not enough recorded runs to plot — {pts.length} of {RUNTIME_TREND_MIN_POINTS} needed.
      </p>
    );
  }
  const ordered = [...pts].reverse();
  const min = Math.min(...ordered);
  const max = Math.max(...ordered);
  const span = max - min || 1;
  const W = 100;
  const H = 34;
  const d = ordered
    .map((v, i) => `${(i / (ordered.length - 1)) * W},${H - ((v - min) / span) * (H - 5) - 2.5}`)
    .join(" ");

  return (
    <div className="flex gap-3">
      <div
        className="flex shrink-0 flex-col justify-between text-[10px] text-[var(--text-muted)]"
        style={{ height: H }}
      >
        <span>{format(max)}</span>
        <span>{format(min)}</span>
      </div>
      <div className="min-w-0 flex-1">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: H }} aria-hidden>
          <polyline
            points={d}
            fill="none"
            stroke="color-mix(in srgb, var(--emerald-400) 65%, transparent)"
            strokeWidth={1.25}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="mt-1 flex justify-between text-[10px] text-[var(--text-muted)]">
          <span>{ordered.length} runs ago</span>
          <span>now</span>
        </div>
      </div>
    </div>
  );
}
