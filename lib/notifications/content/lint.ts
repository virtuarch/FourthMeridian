/**
 * lib/notifications/content/lint.ts  (Comms Center B1 — the content lexicons, contract v1.1 §2.5, §4.4)
 *
 * Deterministic, conservative text checks shared by the manual-draft validator
 * and the AI-output checks. CLOSED lists, pinned by content.test.ts. A false
 * positive costs a rejection (AI) or a warning (manual); the operator can
 * always edit by hand.
 *
 * NORMALISATION FIRST (review P1/P3): every check runs on `normalise(text)` —
 * the {{placeholders}} removed (a placeholder name can never trip a lexicon),
 * NFKC (full-width "ｅｖｉｌ．ｃｏｍ" → "evil.com"), lower-cased, every Unicode
 * space (NBSP, thin space …) → " ", every Unicode hyphen / dash (non-breaking
 * hyphen, en / em dash, minus) → "-", zero-width characters removed.
 *
 * LINKS (mail clients auto-link bare domains, so the owner's "no links" rule
 * covers them too): a URL scheme (incl. defanged hxxp), a protocol-relative
 * "//host", a Markdown link "](", "www.", ANY `label.tld` (a 2–63 letter TLD —
 * no fixed list), an email address, a phone number, and "dot com"-style
 * obfuscation ("evil dot com", "evil[.]com"). Ordinary prose stays clean: the
 * TLD must be letters and at least two of them, so "3.5%", "Q3.", "U.S.",
 * "e.g." and "a.m." never match.
 */

const PLACEHOLDER_TOKEN = /\{\{[a-z][A-Za-z0-9]{0,31}\}\}/g;
export const stripPlaceholders = (s: string): string => s.replace(PLACEHOLDER_TOKEN, " ");

const SPACES = /[   -   　]/g;
const HYPHENS = /[‐-―−﹘﹣－]/g;
const ZERO_WIDTH = /[​-‍⁠﻿­]/g;

/** The canonical form every lexicon reads. */
export function normalise(s: string): string {
  return stripPlaceholders(s).normalize("NFKC").replace(ZERO_WIDTH, "").replace(SPACES, " ").replace(HYPHENS, "-").toLowerCase().replace(/[ \t]+/g, " ");
}

// ── Links ────────────────────────────────────────────────────────────────────
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const LINK_PATTERNS: readonly RegExp[] = [
  /\b(?:https?|hxxps?|h\*\*ps?|ftp|sftp|mailto|javascript|data|file|tel|sms|vbscript):/g,
  /(?:^|[^a-z0-9:/])\/\/[a-z0-9]/g,
  /\]\s*\(/g,
  /\bwww\s*\.\s*[a-z0-9]/g,
  new RegExp(`\\b${LABEL}(?:\\.${LABEL})*\\.[a-z]{2,63}\\b`, "g"),
  /[^\s@]+@[^\s@]+\.[^\s@]+/g,
  /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/g,
  // Obfuscation: "evil dot com", "evil (dot) com", "evil[.]com".
  /\b[a-z0-9-]+\s*[[({]?\s*dot\s*[\])}]?\s*(?:com|net|org|io|co|ru|to|me|info|biz|xyz|app|shop|link|ly|do|uk|us|ca)\b/g,
  /[[({]\s*\.\s*[\])}]/g,
];

/** Link-like fragments (URL, domain, email, phone, obfuscated domain) in the text. */
export function linkHits(s: string): string[] {
  const t = normalise(s);
  const out: string[] = [];
  for (const re of LINK_PATTERNS) {
    const m = t.match(re);
    if (m) out.push(...m.map((x) => x.trim()));
  }
  return out;
}

// ── PII-like content: assertOperatorNoteSafe's classes (lib/audit.ts) + addresses ─
const PII_PATTERNS: readonly RegExp[] = [
  /\d{4,}/,
  /\b\d{1,6}\s+[a-z]+(?:\s+[a-z]+)?\s+(?:street|st|avenue|ave|road|rd|lane|ln|boulevard|blvd|drive|dr|court|ct|way)\b/,
  /\b(?:passwd|secret|token|api[_-]?key|bearer|private key)\b/,
];

export function hasPiiLike(s: string): boolean {
  const t = normalise(s);
  return PII_PATTERNS.some((re) => re.test(t));
}

// ── Financial claims and advice ──────────────────────────────────────────────

/** The closed claim lexicon (financial claims, guarantee language). Matched on normalised text. */
export const CLAIM_LEXICON: readonly string[] = [
  "guarantee", "guaranteed", "guarantees", "risk-free", "risk free", "no risk", "returns", "return on",
  "apr", "apy", "interest rate", "save \\$", "earn", "earning", "earnings", "grow your money", "profit", "profits",
  "high yield", "high-yield", "best rate", "free money", "double your", "passive income", "wealth",
];

/** The closed advice lexicon (financial / legal / tax advice, investment imperatives, legal language). */
export const ADVICE_LEXICON: readonly string[] = [
  "you should invest", "we recommend", "we suggest you", "buy", "sell", "invest in", "tax advice", "legal advice",
  "financial advice", "investment advice", "consult a", "deduct", "deductible", "write off", "write-off",
  "legally binding", "liable", "liability", "warranty", "warranties", "indemnify", "indemnification",
  "invest now", "start investing", "act now", "don't miss out", "do not miss out",
];

function lexiconHits(s: string, lexicon: readonly string[]): string[] {
  // Hyphen / space variants of one term are the same term: "risk free" ≡ "risk-free".
  const t = normalise(s).replace(/[’']/g, "'");
  const out: string[] = [];
  for (const term of lexicon) {
    const right = /[a-z0-9]$/.test(term) ? "\\b" : "";
    const pattern = term.split(/[\s-]+/).join("[\\s-]*");
    if (new RegExp(`\\b${pattern}${right}`).test(t)) out.push(term.replace(/\\/g, ""));
  }
  return out;
}

export const claimHits = (s: string) => lexiconHits(s, CLAIM_LEXICON);
export const adviceHits = (s: string) => lexiconHits(s, ADVICE_LEXICON);

const NUMBER_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|half|double|triple";

/**
 * Numbers, currency symbols / codes, percentages — and their SPELLED-OUT forms
 * ("ten percent", "fifty dollars", "per cent") — the figures a claim is made of.
 */
export function figureTokens(s: string): string[] {
  const t = normalise(s);
  const out: string[] = [];
  for (const m of t.matchAll(/[$€£¥₿]|\b(?:usd|eur|gbp|jpy|btc|eth|sol)\b|\d+(?:[.,]\d+)?\s?%?/g)) out.push(m[0].replace(/\s+/g, ""));
  for (const m of t.matchAll(new RegExp(`\\b(?:${NUMBER_WORDS})(?:[\\s-]+(?:${NUMBER_WORDS}))*[\\s-]*(?:percent|per cent|percentage points?|dollars?|bucks|euros?|pounds|times)\\b`, "g"))) out.push(m[0].replace(/[\s-]+/g, " "));
  for (const m of t.matchAll(/\b(?:percent|per cent)\b/g)) out.push(m[0]);
  return out;
}

/** The items of `next` that do not occur in `base` (set semantics). */
export function added(next: readonly string[], base: readonly string[]): string[] {
  const have = new Set(base);
  return [...new Set(next.filter((x) => !have.has(x)))];
}
