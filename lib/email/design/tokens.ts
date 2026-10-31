/**
 * lib/email/design/tokens.ts
 *
 * The email palette. Every value is COPIED from app/globals.css (Atlas Ink
 * neutrals, Brass, Meridian) — email clients cannot read CSS custom properties,
 * so the hex values are inlined here. lib/email/design/design.test.ts pins each
 * one against app/globals.css so the two cannot drift, and checks the WCAG AA
 * contrast of every text/background pair the layout actually uses.
 *
 * Roles:
 *   - Ink neutrals carry all text and surfaces.
 *   - Meridian 600 is the CTA fill (white label, 5.17:1).
 *   - Brass is an ACCENT ONLY: the thin rule under the header and the expiry
 *     notice edge. It never carries text.
 */

export const INK = {
  0:   "#FFFFFF",
  50:  "#F5F7FA",
  100: "#E7EAF1",
  200: "#C9CEDC",
  300: "#9CA4BC",
  400: "#6E7896",
  500: "#4D5774",
  600: "#38415A",
  700: "#262E42",
  800: "#161C2C",
  900: "#0C111D",
  950: "#060911",
} as const;

export const BRASS = {
  400: "#D4A938",
  500: "#C9A227",
} as const;

export const MERIDIAN = {
  300: "#7FAEFF",
  600: "#2563EB",
  700: "#1D4ED8",
} as const;

/**
 * The system font stack from app/globals.css `--font-ui` (no webfont). Family
 * names are SINGLE-quoted: the stack is interpolated into double-quoted
 * `style="…"` attributes, where a double quote would end the attribute.
 */
export const FONT_STACK =
  `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

/**
 * Semantic colours for the two schemes. Light is what every client renders by
 * default (inline styles); dark is applied by the `prefers-color-scheme` block
 * for clients that honour it. Clients that auto-invert (Gmail app, Outlook.com)
 * get the light palette, which uses opaque backgrounds everywhere text sits so
 * an inversion never leaves light text on a transparent field.
 */
export const LIGHT = {
  canvas:      INK[50],
  card:        INK[0],
  border:      INK[100],
  text:        INK[700],
  heading:     INK[900],
  muted:       INK[500],
  panel:       INK[50],
  link:        MERIDIAN[700],
  ctaBg:       MERIDIAN[600],
  ctaText:     INK[0],
  accent:      BRASS[500],
} as const;

export const DARK = {
  canvas:      INK[950],
  card:        INK[900],
  border:      INK[700],
  text:        INK[100],
  heading:     INK[0],
  muted:       INK[300],
  panel:       INK[800],
  link:        MERIDIAN[300],
  ctaBg:       MERIDIAN[600],
  ctaText:     INK[0],
  accent:      BRASS[400],
} as const;
