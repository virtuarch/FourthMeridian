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
import { buildIncidentKey } from "@/lib/platform/incidents/identity";
import { UNREGISTERED_PREFIX } from "@/lib/platform/incidents/operation-key";
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
  /** `undefined` keeps the shorthand key; `null` models a pre-identity legacy row. */
  incidentKey?: string | null;
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
    incidentKey: over.incidentKey === undefined ? `v1::key::${over.id}` : over.incidentKey,
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
/**
 * The rendered rows, each bounded by its own closing tag.
 *
 * NOT `html.split("<li")`: that leaves the list's trailing markup attached to
 * the final fragment, so "these two rows differ" would pass on the footer alone
 * — a check that could never fail is worse than no check.
 */
const rowsOf = (html: string) => html.match(/<li[\s\S]*?<\/li>/g) ?? [];

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

  // ── 13. Two incidents, one label — an operator can still tell them apart ───
  //
  // THE OBSERVED DEFECT (found by rendering the real Preview in a browser). A
  // wallet BALANCE failure and a wallet PRICE failure are two genuine episodes
  // with two identities, and they produced two byte-identical rows:
  //
  //     ERROR  Wallet sync failed / Self-custody · BTC Wallet / Occurred once …
  //
  // Two rows is correct — one episode is one item. What was wrong is that the
  // rows were indistinguishable, because wording keyed on the derived DOMAIN
  // while identity keys on the OPERATION.
  console.log("13. operationally different incidents render distinguishably");
  {
    const walletKey = (stage: string) =>
      buildIncidentKey({ provider: "WALLET", plaidItemId: null,
                         scope: { kind: "WALLET", id: "wallet-1" }, domain: "wallet", stage });
    // ONE captured moment for both rows. `view()` otherwise defaults
    // lastOccurredAt to a FRESH Date.now() per call, and sortIncidentsForOperator
    // orders equal-severity incidents by recency DESC — so whenever the two
    // calls straddle a millisecond boundary the rows swap and the ordered
    // assertions below fail. That made this block pass only when both calls
    // landed in the same millisecond (intermittent under full-suite load).
    // Same fix the investment block below already uses via SAME_MOMENT; with a
    // shared timestamp the sort falls to its `id` tie-break, which is stable.
    const WALLET_MOMENT = MINUTES_AGO(12);
    const wallet = (id: string, stage: string) =>
      view({ id, kind: "WALLET_SYNC_FAILED", provider: "WALLET", detail: { stage },
             financialAccountId: "acct-btc", incidentKey: walletKey(stage),
             lastOccurredAt: WALLET_MOMENT });

    const subjects = {
      "w-balance": { primary: "Self-custody", secondary: "BTC Wallet" },
      "w-price":   { primary: "Self-custody", secondary: "BTC Wallet" },
    };
    const { html, text } = render({
      data: preview([wallet("w-balance", "balance"), wallet("w-price", "price")], subjects),
    });

    check("two wallet episodes are still two rows", rowCount(html) === 2, `${rowCount(html)}`);
    check("both carry the one shared label", (text.match(/Wallet sync failed/g) ?? []).length === 2, text);

    // The assertion that matters: the two rendered rows are no longer the same
    // string. Compared as MARKUP, so a difference invisible to an operator (an
    // id in a key attribute) could not satisfy it.
    const rows = rowsOf(html);
    check("the two rendered rows are NOT identical", rows.length === 2 && rows[0] !== rows[1]);
    check("each row names its own operation in operator words",
      /Reading the wallet balance/.test(rows[0] ?? "") && /Reading the market price/.test(rows[1] ?? ""),
      rows.map((r) => r.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).join("  ||  "));

    // …and none of that is the machine spelling of the stage.
    check("no raw stage spelling reaches the markup",
      !/["'>\s](balance|price|discovery)["'<\s]/.test(html.replace(/wallet balance|market price/g, "")),
      html.slice(0, 300));
    check("no incident key reaches the markup", !html.includes("v1::") && !html.includes("WALLET:"));

    // The five typed investment operations behind ONE label.
    const SAME_MOMENT = MINUTES_AGO(10);
    const invStages = ["investment-events-fetch", "investment-events-instrument",
                       "reconstruction-repair", "investment-import-repair", "opening-position-repair"];
    const invHtml = render({
      data: preview(invStages.map((stage, n) =>
        view({ id: `inv-${n}`, kind: "INVESTMENT_DATA_PERSISTENCE_FAILED", detail: { stage },
               // Deliberately the SAME timestamp for all five: if the rows were
               // allowed to differ by "last seen", distinctness would be proven
               // by the clock rather than by the operation.
               financialAccountId: "acct-fid", lastOccurredAt: SAME_MOMENT,
               incidentKey: buildIncidentKey({ provider: "PLAID", plaidItemId: null,
                 scope: { kind: "FINANCIAL_ACCOUNT", id: "acct-fid" }, domain: "investments", stage }) }))),
    }).html;
    const invRows = rowsOf(invHtml);
    check("five investment episodes render five rows", invRows.length === 5, `${invRows.length}`);
    check("…all sharing one label",
      (invHtml.match(/Investment data persistence failed/g) ?? []).length === 5);
    check("…and all five rows are mutually distinct", new Set(invRows).size === 5);
    check("no investment stage spelling reaches the markup",
      !invStages.some((s) => invHtml.includes(s)), invHtml.slice(0, 400));

    // ── Honest degradation, rendered ─────────────────────────────────────────
    // A legacy row has no identity at all. It renders its label and NOTHING
    // extra — never a plausible-looking operation it cannot prove.
    const legacy = render({ data: preview([view({ id: "leg", kind: "WALLET_SYNC_FAILED", provider: "WALLET",
                                                  detail: { stage: "balance" }, incidentKey: null })]) });
    check("a legacy row with no incident key renders no operation qualifier",
      legacy.text.includes("Wallet sync failed") && !/Reading the/.test(legacy.text), legacy.text);
    check("…and renders no stray separator where the qualifier would be",
      !/failed\s*·/.test(legacy.text), legacy.text);

    // An unregistered operation carries a producer's private spelling. It must
    // not appear on an operator's screen in any form — not raw, not namespaced.
    const unregStage = "a-stage-nobody-typed-carefully";
    const unreg = render({ data: preview([view({ id: "unreg", kind: "INVESTMENT_DATA_PERSISTENCE_FAILED",
      detail: { stage: unregStage },
      incidentKey: buildIncidentKey({ provider: "PLAID", plaidItemId: null,
        scope: { kind: "FINANCIAL_ACCOUNT", id: "a" }, domain: "investments",
        stage: `${UNREGISTERED_PREFIX}${unregStage}` }) })]) });
    check("an unregistered operation leaks neither the stage nor its namespace",
      !unreg.html.includes(unregStage) && !unreg.html.includes(UNREGISTERED_PREFIX), unreg.text);
    check("…and the row is still fully labelled", unreg.text.includes("Investment data persistence failed"));

    // Continuity: a legacy UPSERT_ERROR and the typed kind are ONE incident, so
    // a taxonomy deployment must remain invisible on BOTH wording axes.
    const txKey = buildIncidentKey({ provider: "PLAID", plaidItemId: "item-chase",
                                     domain: "transactions", stage: "transaction-persist" });
    const asLegacy = render({ data: preview([view({ id: "cl", kind: "UPSERT_ERROR", plaidTransactionId: "t",
      detail: { stage: "transaction-persist" }, plaidItemId: "item-chase", incidentKey: txKey })]) });
    const asTyped = render({ data: preview([view({ id: "ct", kind: "TRANSACTION_PERSISTENCE_FAILED",
      detail: { stage: "transaction-persist" }, plaidItemId: "item-chase", incidentKey: txKey })]) });
    check("a legacy and a typed row read identically on the title line",
      asLegacy.text.includes("Transaction persistence failed") &&
      asTyped.text.includes("Transaction persistence failed") &&
      asLegacy.text.includes("Storing bank transactions") &&
      asTyped.text.includes("Storing bank transactions"),
      `${asLegacy.text}\n${asTyped.text}`);
    check("no enum spelling leaks alongside the qualifier",
      !/UPSERT_ERROR|PERSISTENCE_FAILED|_FAILED/.test(asLegacy.text + asTyped.text));
  }

  if (failures > 0) { console.error(`\nincident-preview.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nincident-preview.test: all passed.");
}

main();
