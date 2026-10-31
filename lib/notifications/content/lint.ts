/**
 * lib/notifications/content/lint.ts  (Comms Center B1 — the content lexicons, contract v1.1 §2.5, §4.4)
 *
 * Deterministic, conservative text checks shared by the manual-draft validator
 * and the AI-output checks. Word-boundary, case-insensitive, CLOSED lists pinned
 * by content.test.ts. A false positive costs a rejection (AI) or a warning
 * (manual); the operator can always edit by hand.
 *
 * Every check runs on text with the {{placeholders}} removed, so a placeholder
 * name can never trip a lexicon.
 */

const PLACEHOLDER_TOKEN = /\{\{[a-z][A-Za-z0-9]{0,31}\}\}/g;
export const stripPlaceholders = (s: string): string => s.replace(PLACEHOLDER_TOKEN, " ");

// ── Links: URL, bare domain, email address, phone number ─────────────────────
const LINK_PATTERNS: readonly RegExp[] = [
  /\b(?:https?|ftp|mailto|javascript|data):/i,
  /\bwww\.[a-z0-9-]/i,
  /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|app|dev|ai|us|uk|ca|info|biz|me|xyz|link|ly|gg|tv|site|online|finance|money|bank)\b/i,
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/,
];

/** Link-like fragments (URL, domain, email, phone) in the text. */
export function linkHits(s: string): string[] {
  const t = stripPlaceholders(s);
  const out: string[] = [];
  for (const re of LINK_PATTERNS) {
    const m = t.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
    if (m) out.push(...m.map((x) => x.toLowerCase()));
  }
  return out;
}

// ── PII-like content: assertOperatorNoteSafe's classes (lib/audit.ts) + addresses ─
const PII_PATTERNS: readonly RegExp[] = [
  /\d{4,}/,
  /\b\d{1,6}\s+[A-Za-z]+(?:\s+[A-Za-z]+)?\s+(?:street|st|avenue|ave|road|rd|lane|ln|boulevard|blvd|drive|dr|court|ct|way)\b/i,
  /\b(?:passwd|secret|token|api[_-]?key|bearer|private key)\b/i,
];

export function hasPiiLike(s: string): boolean {
  const t = stripPlaceholders(s);
  return PII_PATTERNS.some((re) => re.test(t));
}

// ── Financial claims ─────────────────────────────────────────────────────────

/** The closed claim lexicon (financial claims, guarantee language). */
export const CLAIM_LEXICON: readonly string[] = [
  "guarantee", "guaranteed", "guarantees", "risk-free", "risk free", "no risk", "returns", "return on",
  "apr", "apy", "interest rate", "save \\$", "earn", "earning", "earnings", "grow your money", "profit", "profits",
  "high yield", "high-yield", "best rate", "free money", "double your", "passive income", "wealth",
];

/** The closed advice lexicon (financial / legal / tax advice and legal language). */
export const ADVICE_LEXICON: readonly string[] = [
  "you should invest", "we recommend", "we suggest you", "buy", "sell", "invest in", "tax advice", "legal advice",
  "financial advice", "investment advice", "consult a", "deduct", "deductible", "write off", "write-off",
  "legally binding", "liable", "liability", "warranty", "warranties", "indemnify", "indemnification",
];

function lexiconHits(s: string, lexicon: readonly string[]): string[] {
  const t = stripPlaceholders(s).toLowerCase();
  const out: string[] = [];
  for (const term of lexicon) {
    // `\b` around the term; "save \$" ends on a symbol, so its right boundary is a lookahead for a digit/space.
    const right = /[a-z0-9]$/.test(term) ? "\\b" : "";
    if (new RegExp(`\\b${term}${right}`, "i").test(t)) out.push(term.replace(/\\/g, ""));
  }
  return out;
}

export const claimHits = (s: string) => lexiconHits(s, CLAIM_LEXICON);
export const adviceHits = (s: string) => lexiconHits(s, ADVICE_LEXICON);

/** Numbers, currency symbols / codes and percentages — the figures a claim is made of. */
export function figureTokens(s: string): string[] {
  const t = stripPlaceholders(s);
  const out: string[] = [];
  for (const m of t.matchAll(/[$€£¥₿]|\b(?:USD|EUR|GBP|JPY|BTC|ETH|SOL)\b|\d+(?:[.,]\d+)?\s?%?/gi)) out.push(m[0].replace(/\s+/g, "").toUpperCase());
  return out;
}

/** The items of `next` that do not occur in `base` (set semantics). */
export function added(next: readonly string[], base: readonly string[]): string[] {
  const have = new Set(base);
  return [...new Set(next.filter((x) => !have.has(x)))];
}
