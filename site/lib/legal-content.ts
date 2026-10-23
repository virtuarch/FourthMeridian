import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Legal Markdown, read from site/content/legal at BUILD time (static export).
 * These files are byte-identical copies of the app's content/marketing/*.md,
 * pinned by lib/public-site-boundary.test.ts at the repository root until the
 * app stops serving its own copies (domain-split Stage F).
 */
const LEGAL_FILES = {
  terms: "terms.md",
  privacy: "privacy.md",
  ai: "legal-ai.md",
} as const;

export type LegalSlug = keyof typeof LEGAL_FILES;

export function loadLegalMarkdown(slug: LegalSlug): string {
  return readFileSync(path.join(process.cwd(), "content", "legal", LEGAL_FILES[slug]), "utf8");
}
