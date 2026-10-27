/**
 * components/space/compact/compact-hero.ts  (COMPACT DASHBOARD — P4/P5)
 *
 * The compact (<1024px) financial hero treatment: a spacious dark-navy panel
 * (the existing --ink-800 surface with a faint meridian glow), generous padding
 * and a hairline border. EVERY utility is `max-lg:` — at ≥1024px the hero
 * renders exactly as before (bare, no card), and the desktop baseline proves it.
 * Applied to the Net Worth, Debt and Cash Flow heroes' root <section>.
 */
export const COMPACT_HERO =
  "max-lg:rounded-2xl max-lg:border max-lg:border-[var(--border-hairline)] max-lg:px-5 max-lg:py-4 max-lg:shadow-[var(--shadow-e2)] " +
  "max-lg:[background:radial-gradient(120%_90%_at_0%_0%,rgba(88,150,251,0.14),transparent_60%),var(--ink-800)]";
