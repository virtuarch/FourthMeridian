/**
 * components/platform/widgets/incident-preview.test.ts  (OPS-2D-5D-1)
 *
 * RENDER-PATH proof for the canonical sync-incident Preview
 * (house pattern: standalone tsx + renderToStaticMarkup, DB-free):
 *
 *   npx tsx components/platform/widgets/incident-preview.test.ts
 *
 * Fixtures are NOT hand-written DTOs. Every item is built by pushing an
 * `IncidentView` through the real `classifySyncIssue` / `syncIssueState` /
 * `toPreviewItem` path, so these assertions exercise the actual semantic
 * authority. A hand-authored `{severity: "critical", title: "..."}` would prove
 * only that React can render a string it was handed.
 *
 * The behaviours pinned here are the ones the migrated surface previously got
 * WRONG or could regress into:
 *   · one episode is one item, with its real occurrence depth
 *   · loading, failure, empty and unknown-subject stay four distinct states
 *   · `detail` cannot reach the markup
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { classifySyncIssue, syncIssueState } from "@/lib/platform/sync-issue-semantics";
import { countBySeverity, sortIncidentsForOperator, toPreviewItem } from "@/lib/platform/incidents/preview-core";
import type { IncidentPreview as IncidentPreviewData, IncidentSubject } from "@/lib/platform/incidents/preview-core";
import type { IncidentView } from "@/lib/platform/incidents/projections";
import { IncidentPreview } from "./IncidentPreview";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SECTION = { id: "s1", key: "cs_sync_issues", label: "Sync Incidents" };
const MINUTES_AGO = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/**
 * Build an IncidentView exactly the way projections.toView does — derived
 * classification, derived state, nothing asserted by hand.
 */
function view(over: {
  id: string;
  kind: string;
  provider?: string;
  detail?: unknown;
  plaidTransactionId?: string | null;
  plaidItemId?: string | null;
  financialAccountId?: string | null;
  occurrenceCount?: number;
  correlatedOccurrenceCount?: number;
  resolved?: boolean;
  referentExists?: boolean;
  lastOccurredAt?: string;
}): IncidentView {
  const classifiable = {
    kind: over.kind,
    provider: over.provider ?? "PLAID",
    detail: over.detail,
    plaidTransactionId: over.plaidTransactionId ?? null,
  };
  const resolved = over.resolved ?? false;
  const last = over.lastOccurredAt ?? MINUTES_AGO(12);
  return {
    id: over.id,
    kind: over.kind,
    provider: over.provider ?? "PLAID",
    plaidItemId: over.plaidItemId ?? null,
    financialAccountId: over.financialAccountId ?? null,
    incidentKey: `v1::key::${over.id}`,
    state: syncIssueState(classifiable, { referentExists: over.referentExists ?? true, resolved }),
    classification: classifySyncIssue(classifiable),
    firstOccurredAt: MINUTES_AGO(600),
    lastOccurredAt: last,
    occurrenceCount: over.occurrenceCount ?? 1,
    correlatedOccurrenceCount: over.correlatedOccurrenceCount ?? 0,
    resolvedAt: resolved ? last : null,
    resolutionKind: resolved ? "AUTOMATIC_RECOVERY" : null,
    resolvingExecutionId: null,
    previousIncidentId: null,
    legacyUncorrelated: (over.occurrenceCount ?? 1) === 0,
  };
}

/** Shape a set of views into the DTO the route returns. */
function preview(views: IncidentView[], subjects: Record<string, IncidentSubject> = {}): IncidentPreviewData {
  const ordered = sortIncidentsForOperator(views);
  return {
    items: ordered.map((v) => toPreviewItem(v, subjects[v.id] ?? { primary: null, secondary: null })),
    activeTotal: views.length,
    moreCount: 0,
    severityCounts: countBySeverity(views),
    truncated: false,
  };
}

function render(props: { data: IncidentPreviewData | null; loading?: boolean; error?: string | null }) {
  const html = renderToStaticMarkup(
    createElement(IncidentPreview, {
      section: SECTION,
      data: props.data,
      loading: props.loading ?? false,
      error: props.error ?? null,
    }),
  );
  return { html, text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
}

const rowCount = (html: string) => (html.match(/<li/g) ?? []).length;

// The realistic pair the runtime harness also creates.
const TX = view({
  id: "inc-tx",
  kind: "TRANSACTION_PERSISTENCE_FAILED",
  plaidItemId: "item-chase",
  plaidTransactionId: "txn-1",
  // `cursorBlocking` is what makes the ONE proven resolver applicable.
  detail: { stage: "transaction-persist", cursorBlocking: true, merchant: "SECRET_MERCHANT_XYZ", amount: 91.44 },
  occurrenceCount: 3,
  correlatedOccurrenceCount: 2,
});
const INV = view({
  id: "inc-inv",
  kind: "INVESTMENT_DATA_PERSISTENCE_FAILED",
  financialAccountId: "acct-fidelity",
  detail: { stage: "investment-events", message: "SECRET_INTERNAL_TRACE" },
  occurrenceCount: 1,
  lastOccurredAt: MINUTES_AGO(1400),
});

function main() {
  // ── 1. One episode is one item ──────────────────────────────────────────────
  console.log("1. one incident episode renders as exactly one preview item");
  {
    const { html } = render({
      data: preview([TX, INV], {
        "inc-tx":  { primary: "Chase",   secondary: null },
        "inc-inv": { primary: "Fidelity", secondary: "Brokerage" },
      }),
    });
    check("two episodes render two rows", rowCount(html) === 2, `got ${rowCount(html)}`);

    // The regression that matters: occurrence depth must NOT multiply rows. The
    // transaction episode has three occurrences and is still one line.
    const deep = render({ data: preview([view({ id: "d", kind: "TRANSACTION_PERSISTENCE_FAILED", occurrenceCount: 40, detail: { stage: "transaction-persist", cursorBlocking: true } })]) });
    check("an episode with 40 occurrences is still ONE row", rowCount(deep.html) === 1, `got ${rowCount(deep.html)}`);
  }

  // ── 2. Occurrences are named as occurrences ────────────────────────────────
  console.log("2. occurrence count is stated honestly");
  {
    const { text } = render({ data: preview([TX, INV]) });
    check('three occurrences read "Occurred 3 times"', text.includes("Occurred 3 times"));
    check('a single occurrence reads "Occurred once"', text.includes("Occurred once"));
    // The two wrong readings the old surface invited.
    check("never labelled as separate incidents", !/\d+\s+incidents\b/i.test(text), text);
    check("never labelled as failed attempts", !/attempt/i.test(text), text);

    // Legacy rows predate the occurrence table: unknowable, and said to be.
    const legacy = render({ data: preview([view({ id: "leg", kind: "UPSERT_ERROR", occurrenceCount: 0, plaidTransactionId: "t" })]) });
    check("a legacy episode reports the count as unavailable, not zero",
      legacy.text.includes("Occurrence count unavailable") && !/Occurred 0/.test(legacy.text));
  }

  // ── 3/4. Canonical label and severity ──────────────────────────────────────
  console.log("3/4. canonical label and severity are rendered, not invented");
  {
    const { text } = render({ data: preview([TX, INV]) });
    check("canonical transaction label", text.includes("Transaction persistence failed"));
    check("canonical investment label", text.includes("Investment data persistence failed"));
    check("canonical severity critical", text.includes("critical"));
    check("canonical severity error", text.includes("error"));
    // Enum spelling must never reach an operator — that was `humanizeKind`.
    check("no enum spelling leaks", !/UPSERT_ERROR|PERSISTENCE_FAILED|_FAILED/.test(text), text);

    // A LEGACY transactions UPSERT_ERROR is the same operator problem as the
    // typed kind (OPS-2D-5B-0 proved they share one identity), so it must read
    // identically. If these ever diverge, a taxonomy deployment becomes visible
    // to operators as a "new" problem.
    const legacyTx = render({ data: preview([view({ id: "l", kind: "UPSERT_ERROR", plaidTransactionId: "t", detail: { stage: "transaction-persist" } })]) });
    check("a legacy transactions row reads with the SAME label as the typed kind",
      legacyTx.text.includes("Transaction persistence failed"));

    // …and a legacy INVESTMENT row must not borrow the transactions wording.
    const legacyInv = render({ data: preview([view({ id: "li", kind: "UPSERT_ERROR", detail: { stage: "investment-events" } })]) });
    check("a legacy investment row is labelled by its OWN domain",
      legacyInv.text.includes("Investment data persistence failed") &&
      !legacyInv.text.includes("Transaction persistence failed"), legacyInv.text);
  }

  // ── 5. Unknown subject stays unknown ───────────────────────────────────────
  console.log("5. an unresolvable subject never renders as healthy or as a guess");
  {
    const { html, text } = render({ data: preview([TX]) }); // no subject map supplied
    check("states the subject is unavailable", text.includes("Affected account unavailable"));
    // Rendered at the same weight as a known subject: "we do not know which
    // account" is not a lesser fact, and dimming it would say it was.
    check("the unavailable subject is not visually de-emphasised",
      !/text-\[var\(--text-faint\)\][^>]*>\s*Affected account unavailable/.test(html) &&
      !html.includes(">Affected account unavailable</span>"), html.slice(0, 600));
    check('does not invent "Unknown bank"', !/unknown bank/i.test(text));
    check("does not fall back to a raw id", !text.includes("item-chase"), text);
    check("does not read as healthy", !/healthy|no impact|not applicable/i.test(text), text);
  }

  // ── 6. Loading is not success ──────────────────────────────────────────────
  console.log("6. loading never renders the empty state");
  {
    const { text } = render({ data: null, loading: true });
    check("shows a loading line", /loading/i.test(text));
    check("does NOT claim there are no incidents", !/no active sync incidents/i.test(text), text);
    check("renders no incident rows", rowCount(render({ data: null, loading: true }).html) === 0);
  }

  // ── 7. Failure is not zero ─────────────────────────────────────────────────
  console.log("7. a failed query renders unavailable, never 'no incidents'");
  {
    const { text } = render({ data: null, error: "Request failed (500)" });
    check("states the status is unavailable", text.includes("Sync incident status unavailable"));
    check("does NOT claim there are no incidents", !/no active sync incidents/i.test(text), text);
    check("explicitly disclaims a zero reading", /not a report of zero/i.test(text));

    // Data present but the fetch failed → still the unavailable state.
    const both = render({ data: preview([TX]), error: "Request failed (500)" });
    check("an error wins over stale data", both.text.includes("Sync incident status unavailable"));
  }

  // ── 8. The honest empty state ──────────────────────────────────────────────
  console.log("8. no active incidents is stated without claiming health");
  {
    const { text } = render({ data: preview([]) });
    check("states there are no active incidents", text.includes("No active sync incidents"));
    check('never says "Everything is healthy"', !/everything is healthy|all healthy|all clear/i.test(text), text);
    check("disclaims that this describes platform health", /does not describe overall platform health/i.test(text));
  }

  // ── 9/10. Recovery availability is stated only where proven ────────────────
  console.log("9/10. recovery availability follows the ONE proven resolver");
  {
    const { text } = render({ data: preview([TX]) });
    check("cursor-blocking transaction persistence offers automatic recovery",
      text.includes("Automatic recovery available"));

    // The three resolver-missing conditions. Staying active is honest behaviour
    // (OPS-2D-5B-2 is deferred), and none of them may read as recovered.
    for (const [kind, detail] of [
      ["INVESTMENT_DATA_PERSISTENCE_FAILED", { stage: "investment-events" }],
      ["IMPORT_ROLLBACK_FAILED",             { stage: "import-rollback-repair" }],
      ["WALLET_SYNC_FAILED",                 { stage: "balance" }],
    ] as const) {
      const r = render({ data: preview([view({ id: `k-${kind}`, kind, provider: kind === "WALLET_SYNC_FAILED" ? "WALLET" : "PLAID", detail })]) });
      check(`${kind}: states there is no automatic recovery rule`,
        r.text.includes("No automatic recovery rule"));
      check(`${kind}: never reads as resolved or recovered`,
        !/resolved|recovered/i.test(r.text), r.text);
    }
  }

  // ── 11. `detail` cannot reach the markup ───────────────────────────────────
  console.log("11. raw diagnostic detail is not rendered");
  {
    const { html } = render({ data: preview([TX, INV]) });
    check("no merchant string", !html.includes("SECRET_MERCHANT_XYZ"));
    check("no internal trace string", !html.includes("SECRET_INTERNAL_TRACE"));
    check("no amount from detail", !html.includes("91.44"));
    check("no stage string", !/transaction-persist|investment-events/.test(html), html.slice(0, 400));
    check("no JSON blob", !/\{&quot;|\{"/.test(html));
  }

  // ── 12. The migrated consumer carries no local semantics ───────────────────
  console.log("12. no local classifier, label map, or count logic survives");
  {
    for (const f of [
      "components/platform/widgets/CsSyncIssuesWidget.tsx",
      "components/platform/widgets/IncidentPreview.tsx",
    ]) {
      const src = strip(f);
      check(`${f}: no local label/humanising map`,
        !/humanizeKind|replace\(\/_\/g/.test(src));
      check(`${f}: no local severity map`,
        !/SEVERITY_COLOR|severityColor|severity\s*===\s*["']critical["']/.test(src));
      check(`${f}: reads no kind/stage/detail to decide meaning`,
        !/\.kind\b|\.stage\b|\.detail\b/.test(src));
      check(`${f}: does not count, sort or filter the incident set`,
        !/\.reduce\(|\.sort\(|items\.filter\(|\.length\s*\+/.test(src));
      check(`${f}: no raw hex colour`, !/#[0-9a-fA-F]{6}\b/.test(src));
    }
    // The presentational component renders the projection's order as given.
    check("IncidentPreview maps items in received order",
      /data\.items\.map\(/.test(strip("components/platform/widgets/IncidentPreview.tsx")));
  }

  if (failures > 0) { console.error(`\nincident-preview.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nincident-preview.test: all passed.");
}

main();
