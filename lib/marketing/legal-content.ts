/**
 * lib/marketing/legal-content.ts
 *
 * Loads the long-form legal Markdown (content/marketing/*.md) from disk for the
 * public legal pages. Server-only: uses node fs at render time. No database, no
 * app business logic — this stays within the landing-page seam (investigation
 * §3) so the eventual repo split carries the Markdown files along with the
 * pages and nothing else.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

/** Legal documents rendered as Markdown, keyed by slug → filename. */
const LEGAL_FILES = {
  terms: "terms.md",
  privacy: "privacy.md",
  ai: "legal-ai.md",
} as const;

export type LegalSlug = keyof typeof LEGAL_FILES;

export function loadLegalMarkdown(slug: LegalSlug): string {
  const file = path.join(process.cwd(), "content", "marketing", LEGAL_FILES[slug]);
  return readFileSync(file, "utf8");
}
