/**
 * scripts/docs-structure.test.ts
 *
 * Guards the documentation lifecycle (ADR-008, docs/README.md "Documentation
 * lifecycle"). Hermetic: reads files under docs/ only, no network, no git.
 *
 *  1. docs/plans/INDEX.md exists, and every plan it links exists.
 *  2. Every INDEXED plan carries the header line directly under its title:
 *       > **Owner:** … · **Status:** DRAFT|ACTIVE|BLOCKED|DONE|SUPERSEDED-BY <path> · **Updated:** YYYY-MM-DD · **PRs:** …
 *  3. Every top-level docs/plans/*.md is either indexed or on LEGACY_UNINDEXED.
 *     A NEW unindexed plan fails here: index it or update an existing doc
 *     instead (update-before-create).
 *  4. LEGACY_UNINDEXED only shrinks (hard cap LEGACY_MAX): when a legacy plan is
 *     deleted (after extraction) or kept as evidence elsewhere, its entry is
 *     removed. The test never requires a legacy plan to stay.
 *  5. Every compatibility stub (first line "# Moved") links to a file that exists.
 *
 * Run: npx tsx scripts/docs-structure.test.ts
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const PLANS = path.join(ROOT, "docs/plans");
const INDEX = path.join(PLANS, "INDEX.md");

/**
 * Plans that predate ADR-008, under review: durable content is extracted into
 * the canonical docs, then the file is deleted (protected evidence is kept
 * outside docs/plans/). Remove an entry when its file goes. Never ADD to this
 * list: a new plan goes into INDEX.md with a header.
 */
const LEGACY_UNINDEXED: readonly string[] = [
  "AI-ACTIVITY-FRAME-PERIOD-DECISION.md",
  "AI-BETA-REASONING-MEMORY-INVESTIGATION.md",
  "AI-CATEGORY-SPENDING-S1-INVESTIGATION.md",
  "AI-COMPOSITIONAL-FINANCE-INVESTIGATION.md",
  "AI-CONVERSATION-DOGFOOD-TUNING.md",
  "AI-CONVERSATION-GOLDENS.md",
  "AI-CONVERSATION-INVESTIGATION.md",
  "AI-CONVERSATION-STATE-MEMORY-ORCHESTRATION-INVESTIGATION.md",
  "AI-COST-CLIP-4-GPT-5-1-EVALUATION.md",
  "AI-COST-CONTROLS-COORDINATION.md",
  "AI-GPT51-ACTIVITY-AVAILABLE-PROBE.md",
  "AI-GPT51-ANCHOR-VS-DISPOSITION-PROBE.md",
  "AI-GPT51-CAUSAL-EVIDENCE-EXPERIMENT.md",
  "AI-GPT51-CAUSAL-EVIDENCE-GAP-INVESTIGATION.md",
  "AI-GPT51-CORPUS-SPAN-SLICE.md",
  "AI-GPT51-HISTORICAL-POSITION-TOOL-CONTRACT-AB.md",
  "AI-GPT51-PROMOTION-DOGFOOD-GATE.md",
  "AI-GPT51-RETRIEVAL-DISPOSITION-EXPERIMENT.md",
  "AI-GPT51-SECOND-MEASURED-FRAME.md",
  "AI-GPT51-TEMPORAL-FRAME-EXPERIMENT.md",
  "AI-GPT51-TWO-FRAME-PRODUCT-GATE.md",
  "AI-INCOME-CHANGES-I1-CLOSURE.md",
  "AI-INCOME-CHANGES-I1-INVESTIGATION.md",
  "AI-LIABILITY-DYNAMICS-L1-INVESTIGATION.md",
  "AI-PREEXECUTION-PLANNING-CONTINUITY-CLOSURE.md",
  "AI-PREEXECUTION-PLANNING-CONTINUITY-INVESTIGATION.md",
  "AI-PROVIDER-READINESS-ASSESSMENT.md",
  "AI-RELIABILITY-BETA-REPORT-2026-10-16.md",
  "AI-RELIABILITY-ISSUE1-FINDINGS-2026-10-16.md",
  "AI-SCENARIO-CONTINUITY-INVESTIGATION.md",
  "AI-SCENARIO-LIQUID-FLOOR-INVESTIGATION.md",
  "AI-SCENARIO-RESULT-CONTINUITY-DESIGN.md",
  "AI-TRANSACTION-PAGE-COVERAGE.md",
  "BETA-BLOCKED-IDENTIFIER-DESIGN-2026-11-01.md",
  "BETA-IMPLEMENTATION-COORDINATION.md",
  "BETA-OWNER-DECISION-MATRIX-2026-10-15.md",
  "BETA-PRODUCT-ANALYTICS-DESIGN.md",
  "BETA-READINESS-REPORT-2026-10-15.md",
  "BRANCHING-DEVELOP-MIGRATION-AUDIT-2026-10-25.md",
  "COMMS-CENTER-API-CONTRACT-v1-2026-10-31.md",
  "COMMS-CENTER-API-CONTRACT-v1.1-DELTA-2026-10-31.md",
  "COMPACT-DASHBOARD-REDESIGN-P1-INVESTIGATION-2026-10-26.md",
  "CONNECTIONS-CRYPTO-HISTORY-RESUME-2026-10-28.md",
  "CRYPTO-HISTORY-AUTONOMY-AUDIT-2026-10-28.md",
  "EMAIL-AND-INVITATION-LIFECYCLE-AUDIT-2026-10-31.md",
  "FABLE-2.6-CONTEXT-ARCHITECTURE.md",
  "FABLE-2.6-PERSONAL-FINANCIAL-INTELLIGENCE.md",
  "FOLLOWUP-BRIEF-AI-PAUSED-MESSAGE.md",
  "MARKETING-PRODUCT-SHOWCASE-2026-10-30.md",
  "OPERATIONALIZATION-INVESTIGATION-2026-10-07.md",
  "OPERATIONALIZATION-P0-REPORT-2026-10-07.md",
  "OPERATIONALIZATION-P1-REPORT-2026-10-08.md",
  "OPS-2D-5-Roadmap.md",
  "OVERNIGHT-2026-10-31-CONSOLIDATED-REPORT.md",
  "OVERNIGHT-2026-10-31-SESSION2-HANDOFF.md",
  "OVERNIGHT-CONNECTIONS-CRYPTO-HISTORY-REPORT-2026-10-28.md",
  "OVERVIEW-UI-CONSOLIDATION.md",
  "OVERVIEW-UI-INVENTORY.md",
  "PLATFORM-OPS-2.0-REDESIGN-PLAN-2026-10-30.md",
  "PLATFORM-OPS-CONTROL-PLANE-INVESTIGATION.md",
  "PLATFORM-OPS-VISUAL-SPEC-2026-10-30.md",
  "PLATFORM-SPACES-2.0-VISUAL-ARCHITECTURE-2026-10-31.md",
  "PLATFORM-SPACES-UX-P2-NAVIGATION-ASSESSMENT.md",
  "PLATFORM-SPACES-UX-REFINEMENT-P1-COORDINATION.md",
  "PLATFORM-SPACES-UX-REFINEMENT-P1-INVESTIGATION-2026-10-14.md",
  "PLATFORM-SPACES-UX-REFINEMENT-P1-REPORT-2026-10-15.md",
  "POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md",
  "PRE-BETA-READINESS-SESSION2-2026-11-01.md",
  "PREVIEW-AI-FAILURE-AND-CONVERSATION-PERSISTENCE-2026-10-26.md",
  "PUBLIC-APP-DOMAIN-SPLIT-ARCHITECTURE.md",
  "Platform-Ops-Prototype-Production-Migration.md",
  "Platform-Spaces-Visualization-Investigation.md",
  "RLS-DISCONNECT-BLAST-RADIUS.md",
  "RLS-SILENT-REFUSAL-CAS.md",
  "ROADMAP.md",
  "Sentry-Production-Health-Investigation.md",
  "UI-HARDENING-REPORT-2026-10-16.md",
  "UI-PLATFORM-COVERAGE.md",
  "UI-SURFACE-COVERAGE.md",
  "V2.7-CASHFLOW-SPENDING-FIXTURE-RECONCILIATION-2026-10-27.md",
  "V2.7-ESTIMATED-BADGE-SEMANTICS-2026-10-27.md",
  "V2.7-FINAL-PERSPECTIVE-UX-PASS-QUEUE-2026-10-27.md",
  "V2.7-FINAL-REMEDIATION-READINESS-REPORT-2026-10-27.md",
  "V2.7-FINAL-UX-PASS-PREVIEW-READINESS-REPORT-2026-10-27.md",
  "V2.7-PERSONAL-SPACE-RELEASE-READINESS-2026-10-27.md",
  "V2.7-PREVIEW-READINESS-REPORT-2026-10-27.md",
  "V2.7-TRANSFER-PAYMENT-CLASSIFICATION-AUDIT-2026-10-27.md",
  "V26-AUDIT-2026-08-31-PRODUCT-REASONING-ARCHITECTURE.md",
  "V26-FOUNDATION-1-FINANCIAL-CONTEXT-FRAME.md",
  "V26-FOUNDATION-2-PERSONAL-UNDERSTANDING-LAYER.md",
  "V26-FOUNDATION-3-FINANCIAL-TRUTH-DATA-MODEL.md",
  "V26-INVESTIGATION-CROSS-SURFACE-VALUE-CONSISTENCY.md",
  "V26-INVESTIGATION-FINAL-HISTORICAL-ENGINE.md",
  "V26-INVESTIGATION-GLOBAL-HISTORICAL-PRICE-CACHE.md",
  "V26-INVESTIGATION-HISTORICAL-CRYPTO-VALUATION.md",
  "V26-INVESTIGATION-HISTORICAL-PRICE-COVERAGE.md",
  "V26-INVESTIGATION-HISTORICAL-VALUATION-INTEGRITY.md",
  "V26-INVESTIGATION-INCOME-TRUTH-AND-EXPECTED-CASH-FLOW.md",
  "V26-INVESTIGATION-NET-WORTH-ATTRIBUTION-RECONCILIATION.md",
  "V26-INVESTIGATION-SHORT-HORIZON-GOAL-SEEK-AND-SPENDING-BASELINE.md",
  "V26-INVESTMENTS-HISTORY-SEMANTICS-FIX.md",
  "V26-OPS-REFRESH-EXECUTION-LEDGER.md",
  "V26-POST-IMPLEMENTATION-AUDIT.md",
  "V26-QUANTITY-1-HISTORICAL-OWNERSHIP-RECONSTRUCTION.md",
  "V26-QUANTITY-1H-BACKSOLVE-INVESTIGATION.md",
  "V26-REASONING-IMPLEMENTATION-PLAN.md",
  "V26-SECTION-WIDGET-WINDOW-CARD-MATRIX.md",
  "V26-SEMANTICS-CONSUMER-CONVERGENCE.md",
  "ai-5-advisor-intelligence.md",
  "ccpay-follow-ups.md",
  "platform-ops-roadmap.md",
  "v2.6-ASSESS-1-LIQUIDITY-BASELINE-REFUSAL.md",
  "v2.6-DEBT-1-SEMANTIC-CONVERGENCE.md",
  "v2.6-ECONOMIC-DATE-CALIBRATION-REPORT.md",
  "v2.6-INVESTIGATION-MULTI-NETWORK-CRYPTO-ARCHITECTURE.md",
  "v2.6-INVESTIGATION-PENDING-BALANCE-CURRENT-STATE.md",
  "v2.6-INVESTIGATION-TRANSFER-TRUTH-EVIDENCE-ARCHITECTURE.md",
  "v2.6-INVESTIGATION-UNATTESTED-DEBT-PAYMENTS.md",
  "v2.6-INVESTIGATION-UNIVERSAL-HISTORICAL-EXPLORATION.md",
  "v2.6-INVESTIGATION-UNIVERSAL-LENS-ROOTS.md",
  "v2.6-L8-ROADMAP-PHASE-A-CLOSE.md",
  "v2.6-LEGACY-1-EMERGENCY-FUND-DISPOSITION.md",
  "v2.6-PROPOSAL-TRANSFER-RESOLUTION-AUTHORITY.md",
  "v2.6-REVIEW-1-ARCHITECTURAL-STATE.md",
  "v2.6-REVIEW-2-ARCHITECTURAL-CORRECTIONS.md",
  "v2.6-REVIEW-3-CENTRALIZATION-AND-DEAD-CODE-AUDIT.md",
  "v2.6-REVIEW-3-EXECUTION-BASELINE.md",
  "v2.6-REVIEW-3-EXECUTION-REPORT.md",
  "v2.6-SEED-1-SEED-CONVERGENCE.md",
  "v2.6-TRANSFER-AUTHORITY-EXECUTION-LEDGER.md",
  "v2.6-TRUTH-10-ACCOUNT-IDENTITY-CONVERGENCE.md",
  "v2.6-TRUTH-7-PHASE-B-FINALIZATION-PROOF.md",
  "v2.6-TRUTH-8-CASHFLOW-DEBT-DEFECT.md",
  "v2.6-TRUTH-9-DEBT-PRESENTATION-CONVERGENCE.md",
  "v2.6-UI-TRUTH-CONVERGENCE-INVENTORY.md",
];

/**
 * Hard cap on LEGACY_UNINDEXED. Each cleanup PR that removes legacy plans
 * LOWERS this constant to the new length, so growing the list needs a visible
 * bump a reviewer will see. Never raise it.
 */
const LEGACY_MAX = 135;

export const HEADER_RE =
  /^> \*\*Owner:\*\* .+ · \*\*Status:\*\* (DRAFT|ACTIVE|BLOCKED|DONE|SUPERSEDED-BY \S+)\b.* · \*\*Updated:\*\* \d{4}-\d{2}-\d{2} · \*\*PRs:\*\* .+$/;

/** The bare status keyword of a header or INDEX cell, qualifiers dropped. */
export function statusKeyword(s: string): string {
  const m = /(DRAFT|ACTIVE|BLOCKED|DONE|SUPERSEDED-BY)/.exec(s);
  return m ? m[1] : "";
}

/** The header must sit directly under the H1, after at most one blank line. */
export function headerOf(text: string): string | null {
  const lines = text.split("\n");
  if (!lines[0]?.startsWith("# ")) return null;
  const candidate = lines[1]?.trim() === "" ? lines[2] : lines[1];
  return candidate && HEADER_RE.test(candidate) ? candidate : null;
}

console.log("header parser");
{
  const good = "# T\n\n> **Owner:** Session 1 · **Status:** ACTIVE · **Updated:** 2026-11-02 · **PRs:** #1\nbody";
  check("accepts the canonical header", headerOf(good) !== null);
  check("accepts a Status qualifier", headerOf(good.replace("ACTIVE", "ACTIVE (B10 paused)")) !== null);
  check("accepts SUPERSEDED-BY <path>", headerOf(good.replace("ACTIVE", "SUPERSEDED-BY docs/systems/x.md")) !== null);
  check("rejects an unknown status", headerOf(good.replace("ACTIVE", "IN-PROGRESS")) === null);
  check("rejects a missing Updated date", headerOf(good.replace("2026-11-02", "today")) === null);
  check("rejects a header buried in the body", headerOf("# T\n\nintro\n" + good.split("\n")[2]) === null);
  check("status keyword drops qualifiers", statusKeyword("ACTIVE (B10 paused)") === "ACTIVE" && statusKeyword(" BLOCKED ") === "BLOCKED");
  check("status keyword of SUPERSEDED-BY <path>", statusKeyword("SUPERSEDED-BY docs/x.md") === "SUPERSEDED-BY");
}

console.log("docs/plans/INDEX.md is the authoritative active list");
const indexText = existsSync(INDEX) ? readFileSync(INDEX, "utf8") : "";
check("INDEX.md exists", indexText.length > 0);
const indexed = [...new Set([...indexText.matchAll(/\]\(([A-Za-z0-9._-]+\.md)\)/g)].map((m) => m[1]))];
check("INDEX.md lists at least one plan", indexed.length > 0, String(indexed.length));
/** INDEX table rows: | [name](file.md) | owner | STATUS | open | */
const indexRows = new Map<string, string>();
for (const line of indexText.split("\n")) {
  const m = /^\|\s*\[[^\]]+\]\(([A-Za-z0-9._-]+\.md)\)\s*\|[^|]*\|\s*([^|]+?)\s*\|/.exec(line);
  if (m) indexRows.set(m[1], m[2]);
}
check("every indexed plan has a table row with a Status column", indexed.every((n) => indexRows.has(n)),
  indexed.filter((n) => !indexRows.has(n)).join(", "));
for (const name of indexed) {
  const file = path.join(PLANS, name);
  if (!existsSync(file)) { check(`indexed plan exists: ${name}`, false); continue; }
  const header = headerOf(readFileSync(file, "utf8"));
  check(`${name}: header under the title`, header !== null);
  if (header) {
    const fromHeader = statusKeyword(header.split("**Status:**")[1] ?? "");
    const fromIndex = statusKeyword(indexRows.get(name) ?? "");
    check(`${name}: INDEX status (${fromIndex || "none"}) equals header status (${fromHeader})`,
      fromIndex !== "" && fromIndex === fromHeader);
  }
}

console.log("every top-level plan is indexed or on the shrinking legacy list");
const topLevel = readdirSync(PLANS).filter((f) => f.endsWith(".md") && f !== "INDEX.md" && statSync(path.join(PLANS, f)).isFile());
const legacy = new Set(LEGACY_UNINDEXED);
const unaccounted = topLevel.filter((f) => !indexed.includes(f) && !legacy.has(f));
check("no unindexed plan outside the legacy list (update-before-create)", unaccounted.length === 0, unaccounted.join(", "));
check(`legacy list never grows (${LEGACY_UNINDEXED.length} ≤ LEGACY_MAX ${LEGACY_MAX})`, LEGACY_UNINDEXED.length <= LEGACY_MAX);
const gone = LEGACY_UNINDEXED.filter((f) => !existsSync(path.join(PLANS, f)));
check("legacy list has no stale entries (remove an entry when its file goes)", gone.length === 0, gone.join(", "));
const both = LEGACY_UNINDEXED.filter((f) => indexed.includes(f));
check("no plan is both indexed and legacy", both.length === 0, both.join(", "));

console.log("compatibility stubs resolve");
{
  const stubs: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md") && readFileSync(p, "utf8").startsWith("# Moved")) stubs.push(p);
    }
  };
  walk(path.join(ROOT, "docs"));
  for (const s of stubs) {
    const m = /\]\(([^)#\s]+)\)/.exec(readFileSync(s, "utf8"));
    check(`stub ${path.relative(ROOT, s)} → existing target`, !!m && existsSync(path.resolve(path.dirname(s), m[1])), m?.[1]);
  }
  check(`stubs scanned (${stubs.length})`, true);
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
