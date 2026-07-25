/**
 * lib/platform/incidents/preview-core.test.ts  (OPS-2D-5D-1)
 *
 * The Preview's contract below the component: ordering, wording, counting, and
 * the boundaries the new read path must not cross.
 *
 *   npx tsx lib/platform/incidents/preview-core.test.ts
 *
 * The component test (components/platform/widgets/incident-preview.test.ts)
 * proves what an operator SEES. This proves what the surface is allowed to
 * DECIDE — which is: ordering and phrasing, and nothing else.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { classifySyncIssue, syncIssueState } from "@/lib/platform/sync-issue-semantics";
import {
  countBySeverity,
  sortIncidentsForOperator,
  toPreviewItem,
} from "./preview-core";
import type { IncidentView } from "./projections";
import { occurrenceText, subjectText, summaryText, RECOVERY_TEXT, SEVERITY_TOKEN } from "@/components/platform/widgets/incident-preview-view";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
function walk(dir: string, out: string[] = []): string[] {
  let e; try { e = readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return out; }
  for (const x of e) {
    if (x.name === "node_modules" || x.name === ".next" || x.name === "prototype") continue;
    const rel = path.join(dir, x.name);
    if (x.isDirectory()) walk(rel, out); else if (/\.tsx?$/.test(x.name)) out.push(rel);
  }
  return out;
}

const ROUTE   = "app/api/platform/customer-success/sync-issues/route.ts";
const PREVIEW = "lib/platform/incidents/preview.ts";
const CORE    = "lib/platform/incidents/preview-core.ts";
const VIEW    = "components/platform/widgets/incident-preview-view.ts";
const WIDGET  = "components/platform/widgets/CsSyncIssuesWidget.tsx";

function view(o: { id: string; kind: string; provider?: string; detail?: unknown;
                   plaidTransactionId?: string | null; at: string; occurrences?: number;
                   correlated?: number; resolved?: boolean }): IncidentView {
  const c = { kind: o.kind, provider: o.provider ?? "PLAID", detail: o.detail,
              plaidTransactionId: o.plaidTransactionId ?? null };
  return {
    id: o.id, kind: o.kind, provider: o.provider ?? "PLAID",
    plaidItemId: null, financialAccountId: null, incidentKey: `v1::${o.id}`,
    state: syncIssueState(c, { referentExists: true, resolved: o.resolved ?? false }),
    classification: classifySyncIssue(c),
    firstOccurredAt: o.at, lastOccurredAt: o.at,
    occurrenceCount: o.occurrences ?? 1,
    correlatedOccurrenceCount: o.correlated ?? 0,
    resolvedAt: null, resolutionKind: null, resolvingExecutionId: null,
    previousIncidentId: null, legacyUncorrelated: false,
  };
}

const T = (iso: string) => iso;
const CRIT_OLD = view({ id: "a", kind: "TRANSACTION_PERSISTENCE_FAILED", detail: { cursorBlocking: true }, at: T("2026-07-01T00:00:00.000Z") });
const ERR_NEW  = view({ id: "b", kind: "WALLET_SYNC_FAILED", provider: "WALLET", at: T("2026-07-26T00:00:00.000Z") });
const ERR_OLD  = view({ id: "c", kind: "IMPORT_ROLLBACK_FAILED", at: T("2026-07-02T00:00:00.000Z") });

function main() {
  // ── 1. Ordering ────────────────────────────────────────────────────────────
  console.log("1. severity outranks recency, and ordering lives in ONE place");
  {
    const order = sortIncidentsForOperator([ERR_NEW, ERR_OLD, CRIT_OLD]).map((v) => v.id);
    // The whole point: a three-week-old held cursor must not be buried under a
    // wallet retry from this morning.
    check("a critical incident outranks a newer error", order[0] === "a", order.join(","));
    check("within a severity band, the most recent comes first", order[1] === "b" && order[2] === "c", order.join(","));

    const tieA = view({ id: "z", kind: "WALLET_SYNC_FAILED", provider: "WALLET", at: T("2026-07-26T00:00:00.000Z") });
    const tieB = view({ id: "y", kind: "WALLET_SYNC_FAILED", provider: "WALLET", at: T("2026-07-26T00:00:00.000Z") });
    check("identical severity+time is broken deterministically by id",
      sortIncidentsForOperator([tieA, tieB]).map((v) => v.id).join(",") === "y,z");
    check("the input array is not mutated",
      sortIncidentsForOperator([ERR_NEW, CRIT_OLD])[0].id === "a" && [ERR_NEW, CRIT_OLD][0].id === "b");

    // A second sort anywhere else is a second ordering authority.
    const sorters = [...walk("components/platform"), ...walk("app/api/platform")]
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => /(items|incidents)\s*[\]\)]?\s*\.sort\(|\.sort\(\(a,\s*b\)[\s\S]{0,120}severity/.test(code(f)));
    check("no incident list is re-sorted outside the core", sorters.length === 0, sorters.join(", "));
  }

  // ── 2. Counting ────────────────────────────────────────────────────────────
  console.log("2. counts describe the full active set, not the rendered rows");
  {
    const counts = countBySeverity([CRIT_OLD, ERR_NEW, ERR_OLD]);
    check("severity distribution is exact", counts.critical === 1 && counts.error === 2 && counts.warning === 0 && counts.info === 0,
      JSON.stringify(counts));
    check("summary names severities, never colour alone",
      summaryText(3, counts) === "3 active incidents · 1 critical · 2 error", summaryText(3, counts));
    check("singular reads naturally", summaryText(1, { critical: 1, error: 0, warning: 0, info: 0 }) === "1 active incident · 1 critical");
    check("a zero-severity band is omitted rather than printed as 0",
      !summaryText(1, { critical: 1, error: 0, warning: 0, info: 0 }).includes("0 "));
  }

  // ── 3. Wording ─────────────────────────────────────────────────────────────
  console.log("3. phrasing states what is proven and nothing more");
  {
    check("one occurrence", occurrenceText({ occurrenceCount: 1, occurrenceCountKnown: true }) === "Occurred once");
    check("many occurrences", occurrenceText({ occurrenceCount: 7, occurrenceCountKnown: true }) === "Occurred 7 times");
    check("unknown depth is stated, never rendered as zero",
      occurrenceText({ occurrenceCount: 0, occurrenceCountKnown: false }) === "Occurrence count unavailable");

    check("an absent subject is null, not a guess", subjectText({ primary: null, secondary: null }) === null);
    check("a blank subject is treated as absent", subjectText({ primary: "  ", secondary: null }) === null);
    check("both halves join", subjectText({ primary: "Chase", secondary: "Checking" }) === "Chase · Checking");
    check("one half stands alone", subjectText({ primary: "Chase", secondary: null }) === "Chase");

    check("no recovery rule is stated plainly", RECOVERY_TEXT.none === "No automatic recovery rule");
    check("there is NO 'recovery in progress' wording — nothing proves it",
      !Object.values(RECOVERY_TEXT).some((t) => /in progress|underway|retrying/i.test(t)));
    check("every severity maps to an existing design token, no raw hex",
      Object.values(SEVERITY_TOKEN).every((t) => t.startsWith("var(--")), Object.values(SEVERITY_TOKEN).join(", "));
    // Measured in-browser: --coral-600 on the rendered card gives critical a
    // 3.28:1 contrast ratio, failing WCAG AA for small text. On a dark surface
    // urgency must come from SATURATION, not darkness — so the deep steps are
    // barred from this map outright rather than left as a tempting choice.
    check("critical does not use a deep coral that fails contrast on dark",
      !/coral-(500|600|700)/.test(SEVERITY_TOKEN.critical), SEVERITY_TOKEN.critical);
    check("no severity uses a deep coral step",
      !Object.values(SEVERITY_TOKEN).some((t) => /coral-(500|600|700)/.test(t)));
  }

  // ── 4. Recovery follows the one proven resolver ────────────────────────────
  console.log("4. recovery availability is not guessed");
  {
    const held = toPreviewItem(CRIT_OLD, { primary: null, secondary: null });
    check("a held cursor is the only automatic-recovery signal", held.recovery === "automatic-available");
    check("a wallet condition has no rule", toPreviewItem(ERR_NEW, { primary: null, secondary: null }).recovery === "none");
    check("an import condition has no rule", toPreviewItem(ERR_OLD, { primary: null, secondary: null }).recovery === "none");

    // A transaction failure that is NOT cursor-blocking (pre-cursor-safety) must
    // not claim recovery — its cursor already advanced, so nothing will replay.
    const advanced = view({ id: "adv", kind: "TRANSACTION_PERSISTENCE_FAILED", detail: {}, at: T("2026-07-01T00:00:00.000Z") });
    check("a non-cursor-blocking transaction failure claims NO automatic recovery",
      toPreviewItem(advanced, { primary: null, secondary: null }).recovery === "none");
  }

  // ── 5. One verdict per row ─────────────────────────────────────────────────
  console.log("5. the label and the domain badge cannot disagree");
  {
    // The bug this guards: re-classifying from `kind` alone hits the
    // conservative transactions fallback, so a legacy investment incident would
    // be badged "investments" and labelled "Transaction persistence failed".
    const legacyInv = view({ id: "li", kind: "UPSERT_ERROR", detail: { stage: "investment-events" }, at: T("2026-07-01T00:00:00.000Z") });
    const item = toPreviewItem(legacyInv, { primary: null, secondary: null });
    check("domain and label agree on a legacy investment row",
      item.domain === "investments" && item.title === "Investment data persistence failed",
      `${item.domain} / ${item.title}`);
    check("the core never calls the classifier itself",
      !/classifySyncIssue\(/.test(code(CORE)));
    check("the core reads the projection's verdict", /view\.classification/.test(code(CORE)));
  }

  // ── 6. No second semantic authority ────────────────────────────────────────
  console.log("6. the new read path derives no meaning of its own");
  {
    for (const f of [CORE, PREVIEW, VIEW, ROUTE, WIDGET, "components/platform/widgets/IncidentPreview.tsx"]) {
      const s = code(f);
      check(`${f}: no severity derivation`, !/deriveSeverity|severity\s*=\s*[^;]*\?\s*["']critical["']/.test(s));
      check(`${f}: no domain inference`, !/inferDomain|STAGE_DOMAIN/.test(s));
      check(`${f}: no local active/resolved arithmetic`,
        !/resolved\s*===\s*false|resolvedAt\s*(===|!==)\s*null|calculateActive/.test(s));
      check(`${f}: no recovery guessing`, !/guessRecovery|lastRun|lastSuccessful/.test(s));
      check(`${f}: never reads detail`, !/\.detail\b|SyncIssue\.detail/.test(s));
    }
  }

  // ── 7. The route: authorization, one projection, no db ─────────────────────
  console.log("7. the route stays a thin, scoped, READ-gated seam");
  {
    const s = code(ROUTE);
    check("requires CUSTOMER_SUCCESS READ",
      /requirePlatformAccess\(\s*["']CUSTOMER_SUCCESS["']\s*,\s*["']READ["']\s*\)/.test(s));
    check("never requests WRITE", !/["']WRITE["']/.test(s));
    check("authorizes BEFORE reading",
      s.indexOf("requirePlatformAccess") < s.search(/getIncidentPreview\(/));
    check("consumes the canonical preview and nothing else",
      /getIncidentPreview\(/.test(s) && !/getActiveIncidents|getHistoricalIncidents|getIncidentDetail/.test(s));
    check("touches no database directly", !/@\/lib\/db|db\.syncIssue|db\.plaidItem/.test(s));
    check("does not re-import the semantics authority", !/sync-issue-semantics/.test(s));
    check("exports no mutating verb", !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(s));

    // The legacy row-count path is GONE, not left running underneath.
    check("no in-memory active scan survives", !/ACTIVE_SCAN_CAP|findMany/.test(s));
    check("no per-kind row counting survives", !/byKind|counts\.set|unresolvedTotal/.test(s));
    check("no stall reconstruction survives", !/projectItemStall|stalled|unpersistedCount|attempts/.test(s));
  }

  // ── 8. Scope — the browser and the resolvers did not start ─────────────────
  console.log("8. Preview only: no browser, no resolver, no operator controls");
  {
    const controlRoutes = walk("app/api").filter((f) => /\/incidents?\//.test(f));
    check("no incident browser API was built", controlRoutes.length === 0, controlRoutes.join(", "));

    for (const f of [CORE, PREVIEW, VIEW, "components/platform/widgets/IncidentPreview.tsx"]) {
      const s = code(f);
      check(`${f}: no resolution kind is produced`,
        !/AUTOMATIC_RECOVERY|resolveByAutomaticRecovery|OPERATOR_ACTION|manualResolve/.test(s));
      check(`${f}: no acknowledgement or bulk action`, !/acknowledg|bulkResolve|dismiss/i.test(s));
      check(`${f}: no filter/search machinery`, !/useSearchParams|filters?\s*:|searchQuery/.test(s));
    }
    // Preview is read-only: the surface must not offer a write.
    check("the widget issues no mutating fetch", !/method:\s*["'](POST|PUT|PATCH|DELETE)["']/.test(code(WIDGET)));
  }

  if (failures > 0) { console.error(`\npreview-core.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\npreview-core.test: all passed.");
}

main();
