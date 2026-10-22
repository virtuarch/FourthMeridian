/**
 * lib/money/round.ts   (FIN-013 — one rounding rule, one epsilon)
 *
 * THE money rounding helper and THE money comparison epsilon. Before this file
 * the repo held seventeen local `round2` copies and three `MONEY_EPSILON`
 * definitions (runtime audit, 2026-10-21) — all numerically identical today,
 * which is exactly the state in which one of them silently stops being.
 *
 * Doctrine (the forecast engine's D-4 note): full f64 precision end to end, ONE
 * rounding at the edge. `round2` is that edge; `MONEY_EPSILON` is how two money
 * figures are compared without rounding either (a 2.8e-14 residue is not a
 * debt). Pure, dependency-free, importable from anywhere including scripts.
 */

/** Round to cents. Half-up on the magnitude of the scaled value, as `Math.round` does. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Half a cent. Two money figures closer than this are the same figure; a
 * balance above −MONEY_EPSILON is not negative. Compares, never rounds.
 */
export const MONEY_EPSILON = 0.005;
