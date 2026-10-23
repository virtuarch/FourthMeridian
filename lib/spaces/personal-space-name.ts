/**
 * lib/spaces/personal-space-name.ts  (2026-10-07)
 *
 * The Personal Space's GENERATED name follows the owner's first name until the
 * owner chooses a name of their own. Registration names the Space
 * `${possessive(firstName)} Space`; a typo at sign-up ("Brandom") later
 * corrected in Settings left "Brandom's Space" behind forever.
 *
 * NO SCHEMA FLAG. A name is "still generated" iff it is EXACTLY what
 * registration (or a legacy writer) would have produced from the PREVIOUS
 * first name. Anything else — including a name the user typed that merely
 * contains their first name — is a customization and is never touched. The
 * only theoretical false positive is a user who deliberately typed the exact
 * generated name, which is the same name either way.
 */

import { possessive } from "@/lib/format";

/** What registration writes for a first name. */
export function generatedPersonalSpaceName(firstName: string): string {
  return `${possessive(firstName.trim())} Space`;
}

/** Every form a generator has ever written for this first name (see displaySpaceName). */
function generatedForms(firstName: string): Set<string> {
  const f = firstName.trim();
  return new Set([
    generatedPersonalSpaceName(f),
    `${f}'s Space`,                    // pre-possessive() rows ("Chris's Space")
    `${possessive(f)} Dashboard`,      // pre-"Space" vocabulary
    `${f}'s Dashboard`,
  ]);
}

/**
 * The name the Personal Space should take after a first-name change, or null
 * to leave it alone (customized, unchanged, or no name to derive from).
 */
export function followedPersonalSpaceName(
  currentSpaceName: string,
  previousFirstName: string | null | undefined,
  nextFirstName: string,
): string | null {
  const prev = previousFirstName?.trim() ?? "";
  const next = nextFirstName.trim();
  if (!prev || !next || prev === next) return null;
  if (!generatedForms(prev).has(currentSpaceName)) return null;
  const renamed = generatedPersonalSpaceName(next);
  return renamed === currentSpaceName ? null : renamed;
}
