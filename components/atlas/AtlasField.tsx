/**
 * components/atlas/AtlasField.tsx
 *
 * Ambient page background — "Atlas Field", Fourth Meridian Design Language
 * v1. Renders the project's own Fourth Meridian Atlas artwork
 * (public/fourth-meridian-dark.png / fourth-meridian-light.png — brand
 * globe, baked-in meridian grid, brass horizon glow), blurred, darkened,
 * and masked so it reads as a recognizable but unobtrusive backdrop rather
 * than a literal wallpaper photo or a colorful "nebula" glow. Decorative
 * only, never interactive.
 *
 * Usage — render as a child of a `relative isolate` ancestor that is a
 * common ancestor of everything the field should appear to sit behind, so
 * the field's negative z-index is scoped to that ancestor's own stacking
 * context (and therefore can't be painted over by an unrelated sibling,
 * e.g. the Sidebar):
 *
 *   <div className="relative isolate">
 *     <AtlasField />
 *     ...header, page content, etc. (all auto/positive z-index, paint above it)...
 *   </div>
 *
 * As of Phase G this is wired into components/ui/DashboardChrome.tsx (opt-in
 * per route via `isSpaces`, not globally) rather than into the Spaces page's
 * own content wrapper — that's what lets the field paint behind the shared
 * header strip too, not just the page content below it. Still opt-in to
 * Spaces only, so unrelated dashboard tabs are untouched by this redesign.
 */

/**
 * `intensity` (Refraction-test material-eval pass):
 *   "rich"     — full globe/grid treatment (Space Dashboard, the primary
 *                workspace). Default.
 *   "balanced" — dialed-back globe/grid for the everyday Dashboard so the same
 *                language reads calmer behind data-dense panels (see the
 *                .is-balanced overrides in globals.css).
 */
export function AtlasField({ intensity = "rich" }: { intensity?: "rich" | "balanced" }) {
  return (
    <div
      className={`atlas-field ${intensity === "balanced" ? "is-balanced" : "is-rich"}`}
      aria-hidden
    >
      {/* Midnight/Light Glass Earth — same two assets EarthBackground.tsx
          falls back to. The dark/light swap is pure CSS (html[data-theme])
          so this stays a hook-free, server-renderable component. */}
      <div className="atlas-globe atlas-globe-dark" />
      <div className="atlas-globe atlas-globe-light" />

      {/* Faint globe-grid geometry — meridian/latitude curves, drawn once
          inline rather than as a new image asset. One warm Brass arc reads
          as a distant horizon highlight. */}
      <svg
        className="atlas-meridians"
        viewBox="0 0 1000 560"
        preserveAspectRatio="xMidYMin slice"
        aria-hidden
        focusable="false"
      >
        {/* Denser graticule (refraction-test pass) — more longitude ellipses and
            latitude bands give the glass more regular line-work to visibly bend
            against, which is the clearest way to judge whether refraction reads. */}
        <g fill="none" stroke="currentColor" strokeWidth={1}>
          <circle cx={500} cy={260} r={300} />
          <ellipse cx={500} cy={260} rx={245} ry={300} />
          <ellipse cx={500} cy={260} rx={190} ry={300} />
          <ellipse cx={500} cy={260} rx={130} ry={300} />
          <ellipse cx={500} cy={260} rx={70} ry={300} />
          <ellipse cx={500} cy={110} rx={252} ry={70} />
          <ellipse cx={500} cy={170} rx={280} ry={80} />
          <ellipse cx={500} cy={260} rx={300} ry={104} />
          <ellipse cx={500} cy={360} rx={280} ry={70} />
          <ellipse cx={500} cy={430} rx={250} ry={60} />
        </g>
        <path
          d="M 180 120 Q 500 30 820 130"
          fill="none"
          stroke="var(--brass-400)"
          strokeWidth={1.5}
          strokeLinecap="round"
          opacity={0.6}
        />
      </svg>
    </div>
  );
}
