/**
 * lib/imports/investments/import-validation.ts
 *
 * A7-6 — the pure wrong-file / wrong-provider / wrong-account SAFETY core. DB-free,
 * deterministic, fully unit-testable; the routes and UI are thin over this. The
 * critical property: nothing here trusts a display label — it reasons over the
 * file's own header signature and the target account's stable identity, and
 * expresses CONFIDENCE rather than a naive boolean, so the UI can block, warn, or
 * require explicit confirmation honestly.
 *
 * Three concerns:
 *   1. detectInvestmentSource — which broker/source a file's headers look like,
 *      with confidence + evidence (never guesses a certain match it can't defend).
 *   2. checkImportCompatibility — does the detected source fit the selected
 *      connection? High-confidence brand mismatch ⇒ blocking (Coinbase→Schwab).
 *   3. assessImportRows — is there any importable investment fact at all? Empty /
 *      malformed / non-investment / no-records / all-invalid / duplicate-only are
 *      distinguished, so a résumé or bank statement is rejected BEFORE commit and
 *      never becomes an ImportBatch with canonical rows.
 * Plus maskAccountLabel — never render a full identifier.
 */

const norm = (h: string): string => h.trim().toLowerCase().replace(/\s+/g, " ");

// ── 1. Source detection ─────────────────────────────────────────────────────────

export type DetectedSource = "csv:schwab" | "csv:fidelity" | "coinbase" | "csv:generic" | "unknown";
export type DetectionConfidence = "high" | "medium" | "low" | "none";

export interface SourceDetection {
  source:       DetectedSource;
  confidence:   DetectionConfidence;
  /** Human, name-free evidence lines ("matched columns: Action, Fees & Comm"). */
  evidence:     string[];
  /** True when the file plausibly holds investment records at all (else Case 2). */
  investmentLike: boolean;
  /** Whether the detected source is a specific named broker (vs generic/unknown). */
  branded:      boolean;
}

interface SourceSignature {
  source:           DetectedSource;
  branded:          boolean;
  /**
   * Headers UNIQUE to this source's export format. A branded source is only
   * identified when ≥1 distinctive header is present — so a generic investment
   * CSV (Symbol/Quantity/Amount/Action) never masquerades as a specific broker.
   */
  distinctive:      string[];
  /** Common investment headers that corroborate but don't identify. */
  supporting:       string[];
  /** Minimum total (distinctive + supporting) hits to positively identify. */
  threshold:        number;
  /** Institution-name substrings this source is compatible with (lowercased). */
  institutionHints: string[];
}

/** Ordered most-specific → least. Generic is the permissive, never-branded fallback. */
const SIGNATURES: SourceSignature[] = [
  { source: "coinbase",     branded: true,  threshold: 3, institutionHints: ["coinbase"],
    distinctive: ["quantity transacted", "spot price currency", "spot price at transaction", "transaction type"],
    supporting:  ["timestamp", "asset", "subtotal"] },
  { source: "csv:fidelity", branded: true,  threshold: 3, institutionHints: ["fidelity"],
    distinctive: ["run date", "commission ($)", "amount ($)", "price ($)"],
    supporting:  ["action", "symbol", "type", "quantity"] },
  { source: "csv:schwab",   branded: true,  threshold: 3, institutionHints: ["schwab"],
    distinctive: ["fees & comm"],
    supporting:  ["action", "symbol", "quantity", "price", "amount"] },
  { source: "csv:generic",  branded: false, threshold: 2, institutionHints: [],
    distinctive: [],
    supporting:  ["symbol", "quantity", "trade date", "ticker", "action", "amount"] },
];

/** Header families that indicate the file holds SOME investment record. */
const INVESTMENT_SIGNAL = ["symbol", "ticker", "asset", "quantity", "quantity transacted", "shares"];
const DATE_SIGNAL = ["date", "trade date", "run date", "timestamp", "as of date", "statement date", "activity date"];

/**
 * Detect the likely source from a file's headers. Confidence is `high` when a
 * branded signature clears its threshold with a ≥2 margin over the runner-up,
 * `medium` at threshold, `low` when only the generic shape matches, `none` when
 * nothing investment-like is present.
 */
export function detectInvestmentSource(headers: string[]): SourceDetection {
  const H = new Set(headers.map(norm));
  const hit = (m: string) => H.has(m);
  const investmentLike = INVESTMENT_SIGNAL.some(hit) && DATE_SIGNAL.some(hit);

  const scored = SIGNATURES.map((sig) => {
    const distinctiveHits = sig.distinctive.filter(hit);
    const matched = [...distinctiveHits, ...sig.supporting.filter(hit)];
    // A branded source needs ≥1 distinctive header; generic needs none.
    const eligible = sig.branded ? distinctiveHits.length > 0 : true;
    return { sig, matched, score: eligible ? matched.length : 0 };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1]?.score ?? 0;

  if (!best || best.score < best.sig.threshold) {
    return {
      source: "unknown",
      confidence: investmentLike ? "low" : "none",
      evidence: investmentLike ? ["Recognizable investment columns, but no known broker signature."] : ["No recognizable investment columns."],
      investmentLike,
      branded: false,
    };
  }

  const branded = best.sig.branded;
  const confidence: DetectionConfidence = !branded
    ? "low"
    : best.score - runnerUp >= 2 ? "high" : "medium";

  return {
    source: best.sig.source,
    confidence,
    evidence: [`Matched columns: ${best.matched.join(", ")}.`],
    investmentLike: investmentLike || branded,
    branded,
  };
}

// ── 2. Compatibility with the selected connection ───────────────────────────────

export interface ConnectionIdentity {
  /** Stable connection id (PlaidItem.id today) — never a display label alone. */
  connectionId: string;
  institution:  string;
}

export interface CompatibilityResult {
  compatible:           boolean;
  /** A high-confidence brand mismatch — commit must be blocked. */
  blockingMismatch:     boolean;
  /** Compatibility is plausible but unproven — the user must confirm explicitly. */
  requiresConfirmation: boolean;
  /** One deterministic, user-facing, name-free sentence. */
  reason:               string;
}

const institutionMatchesHints = (institution: string, hints: string[]): boolean => {
  const inst = institution.toLowerCase();
  return hints.some((h) => inst.includes(h));
};

const brandLabel: Record<DetectedSource, string> = {
  "coinbase": "Coinbase", "csv:schwab": "Schwab", "csv:fidelity": "Fidelity", "csv:generic": "a generic investment export", "unknown": "an unrecognized file",
};

/**
 * Compare a detected source against the selected connection. A branded,
 * ≥medium-confidence source whose institution hints do NOT appear in the
 * connection's institution is a BLOCKING mismatch (Case 1: a Coinbase export from
 * a Schwab card). A matching brand is compatible. Generic/unknown/low-confidence
 * never auto-passes — it requires explicit user confirmation (never pretends
 * certainty).
 */
export function checkImportCompatibility(detection: SourceDetection, connection: ConnectionIdentity): CompatibilityResult {
  const sig = SIGNATURES.find((s) => s.source === detection.source);

  if (detection.branded && sig && (detection.confidence === "high" || detection.confidence === "medium")) {
    if (institutionMatchesHints(connection.institution, sig.institutionHints)) {
      return { compatible: true, blockingMismatch: false, requiresConfirmation: false, reason: `This looks like a ${brandLabel[detection.source]} export, matching this connection.` };
    }
    return {
      compatible: false, blockingMismatch: true, requiresConfirmation: false,
      reason: `This appears to be a ${brandLabel[detection.source]} export, but you selected ${connection.institution}. Choose the correct connection or import it as a new file source.`,
    };
  }

  // Generic / unknown / low confidence — plausible but unproven; require review.
  return {
    compatible: false, blockingMismatch: false, requiresConfirmation: true,
    reason: `We could not confirm this file belongs to ${connection.institution}. Review the target before importing.`,
  };
}

// ── 3. File / row assessment (Case 2) ───────────────────────────────────────────

export type FileVerdict =
  | "ok"
  | "unreadable"        // parser threw
  | "malformed-csv"     // parsed but no header row / no rows
  | "not-investment"    // no investment columns at all (résumé, random sheet)
  | "missing-columns"   // recognizable-ish but required columns absent
  | "no-records"        // headers ok, zero data rows
  | "all-invalid"       // every row failed to parse
  | "duplicate-only";   // every valid row already exists (safe, non-error)

export interface FileAssessment {
  verdict:   FileVerdict;
  /** True ⇒ commit must be refused (no ImportBatch with canonical rows). */
  blocking:  boolean;
  reason:    string;
}

export interface RowAssessmentInput {
  parseError:      string | null;   // pipeline file-level error (null if parsed)
  investmentLike:  boolean;         // from detectInvestmentSource
  missingRequired: string[];        // pipeline resolveColumns "missing"
  totalRows:       number;
  invalidRows:     number;          // rows with a per-row error
  createRows:      number;          // rows that would CREATE
  matchRows:       number;          // rows that MATCH an existing record
}

/**
 * Decide whether a parsed file carries any importable investment fact. Ordered
 * from hardest failure to softest so the message is the most specific true one.
 * `duplicate-only` is NOT an error (safe re-import) — it is surfaced honestly and
 * commit is allowed (a no-op), never presented as a failure.
 */
export function assessImportRows(a: RowAssessmentInput): FileAssessment {
  if (a.parseError) {
    // A file-level pipeline error is either "can't read it" or "wrong columns".
    const missing = a.missingRequired.length > 0;
    return {
      verdict: missing ? "missing-columns" : "malformed-csv",
      blocking: true,
      reason: missing
        ? `This file is missing required investment columns (${a.missingRequired.join(", ")}). It may not be a supported investment export.`
        : "We could not read a valid table from this file.",
    };
  }
  if (!a.investmentLike) {
    return { verdict: "not-investment", blocking: true, reason: "We could not identify a supported investment export in this file." };
  }
  if (a.totalRows === 0) {
    return { verdict: "no-records", blocking: true, reason: "This file has no investment records to import." };
  }
  if (a.invalidRows >= a.totalRows) {
    return { verdict: "all-invalid", blocking: true, reason: "None of the rows in this file could be read as investment records." };
  }
  if (a.createRows === 0 && a.matchRows > 0) {
    return { verdict: "duplicate-only", blocking: false, reason: "Every record in this file is already imported — importing again will change nothing." };
  }
  return { verdict: "ok", blocking: false, reason: "Ready to import." };
}

// ── 4. Account safety (Cases 3 & 4) ─────────────────────────────────────────────

export interface AccountMappingInput {
  /** Distinct account identifiers PARSED from the file (masks/numbers), if any. */
  fileAccountIdentifiers: string[];
  /** Last-4 mask of the selected target account (FinancialAccount.mask), if known. */
  targetMask:             string | null;
}

export type AccountVerdict = "ok" | "unverified" | "mismatch" | "multi-account";

export interface AccountAssessment {
  verdict:              AccountVerdict;
  blocking:             boolean;
  requiresConfirmation: boolean;
  reason:               string;
}

/**
 * Assess the file's account identity against the selected target. The pipeline
 * does not parse an account column today, so `fileAccountIdentifiers` is usually
 * empty ⇒ `unverified` (require explicit confirmation, never silent commit). When
 * the file DOES carry account identifiers: multiple distinct ⇒ multi-account
 * (block, require independent review — never collapse into one account); a single
 * identifier that doesn't match the target mask ⇒ mismatch (block).
 */
export function assessAccountMapping(a: AccountMappingInput): AccountAssessment {
  const ids = [...new Set(a.fileAccountIdentifiers.map((s) => s.trim()).filter(Boolean))];
  if (ids.length > 1) {
    return { verdict: "multi-account", blocking: true, requiresConfirmation: false, reason: `This file contains records for ${ids.length} accounts. Map each account before importing.` };
  }
  if (ids.length === 1 && a.targetMask) {
    const last4 = ids[0].replace(/\D/g, "").slice(-4);
    if (last4 && last4 !== a.targetMask) {
      return { verdict: "mismatch", blocking: true, requiresConfirmation: false, reason: `This export appears to belong to an account ending in ${last4}, not the selected account ending in ${a.targetMask}.` };
    }
    return { verdict: "ok", blocking: false, requiresConfirmation: false, reason: "The file's account matches the selected account." };
  }
  return { verdict: "unverified", blocking: false, requiresConfirmation: true, reason: "Confirm the target account — the file does not state which account it belongs to." };
}

// ── 5. Masking ──────────────────────────────────────────────────────────────────

/** Never render a full identifier. "account ending in 4421", or a safe fallback. */
export function maskAccountLabel(mask: string | null | undefined, name?: string | null): string {
  const clean = (mask ?? "").replace(/\D/g, "").slice(-4);
  if (clean) return `account ending in ${clean}`;
  return name ? name : "this account";
}
