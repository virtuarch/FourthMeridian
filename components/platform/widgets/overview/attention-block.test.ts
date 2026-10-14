/**
 * components/platform/widgets/overview/attention-block.test.ts  (UX-P1 · Agent 2)
 *
 * RENDER-PATH proof for the Attention Required block:
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/overview/attention-block.test.ts
 *
 * Pinned:
 *   1. the self-fetching block's first frame is loading inside ONE SectionSurface
 *   2. rows render in the SERVER's order — the UI never re-sorts
 *   3. severity is a word (ToneBadge), the six columns exist, md: collapse by class
 *   4. the empty state counts authorities and never says healthy
 *   5. a failed authority is announced as an alert
 *   6. recent firings are history, rendered apart from the rows and labelled so
 *   7. write actions render only with canWrite; run-now is a doorway
 *   8. evidence: execution → inspect button; otherwise a registry-labelled doorway
 *   9. the row expansion carries the dropped columns and the basis
 *  10. no customer identity reaches the markup; the block fetches once, derives nothing
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AttentionBlock, AttentionRowDetail, AttentionSurface } from "./AttentionBlock";
import { buildAttention, type AttentionInputs } from "@/lib/platform/ops/attention-core";
import type { AttentionResponse } from "@/lib/platform/ops/attention";
import { ATTENTION_FOOTNOTE, filterItems } from "./attention-view";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOW = new Date("2026-10-14T12:00:00.000Z");
const AGO = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const inputs: AttentionInputs = {
  connections: {
    total: 3, counts: { HEALTHY: 1, STALE: 1, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 1, REVOKED: 0 },
    unhealthy: [
      { source: "PLAID", id: "item_err", label: "Chase", status: "ERROR", errorCode: "ITEM_LOGIN_REQUIRED", healthState: "ERROR", lastSyncedAt: AGO(30), since: AGO(26) },
      { source: "WALLET", id: "conn_w", label: "Wallet …abc123", status: "ACTIVE", errorCode: null, healthState: "STALE", lastSyncedAt: AGO(10), since: null },
    ],
    retired: { revoked: 0, ownerInactive: 0 },
  },
  jobs: { jobs: [{ job: "sync-banks", status: "failing", expectedEveryHours: 24, consecutiveFailures: 3, lastStartedAt: AGO(6), lastFailureAt: AGO(6), lastFailureSummary: "Plaid timed out" }] },
  providers: { checkedAt: NOW, counts: { OPERATIONAL: 1, DEGRADED: 0, STALE: 0, FAILING: 0, UNKNOWN: 0 }, providers: [] },
  resources: { checkedAt: NOW, allFresh: true, resources: [] },
  alerts: {
    latest: { evaluatedAtISO: AGO(2), deliveryStatus: "sent", counts: { evaluated: 1, live: 1, enabled: 1, firing: 1, delivered: 1, suppressed: 0 },
      rules: [{ id: "job-failing", kind: "job-failing", enabled: true, live: true, firing: true, breaches: 1, severity: "critical" }] },
    titles: { "job-failing": "Repeated job failures" },
  },
  incidents: {
    items: [{ id: "inc_a", label: "Transaction persistence failed", operationLabel: "storing delivered transactions", subject: "Chase · Checking", domain: "transactions", severity: "critical", state: "active", firstOccurredAt: AGO(100), lastOccurredAt: AGO(2), occurrenceCount: 4, occurrenceCountKnown: true, recovery: "automatic-available", refreshExecutionId: "exec_abc123" }],
    activeTotal: 1, truncated: false,
  },
};

function response(over: Partial<AttentionResponse> = {}, inp: AttentionInputs = inputs): AttentionResponse {
  const core = buildAttention(inp, NOW);
  return {
    checkedAt: NOW.toISOString(),
    items: core.items,
    counts: core.counts,
    authoritiesChecked: { count: core.authorities.checked.length, names: core.authorities.checked },
    authoritiesFailed: core.authorities.failed,
    floors: core.floors,
    recentFirings: {
      runs: 10, newestEvaluatedAt: AGO(2), oldestEvaluatedAt: AGO(60), count: 1,
      items: [{ ruleId: "resource-stale", kind: "resource-stale", dedupeKey: "resource-stale:fx", severity: "warning", summary: 'Resource "fx-rates" is stale — HISTORICAL-ONLY', deliveredAtISO: AGO(50) }],
    },
    ...over,
  };
}

const render = (data: AttentionResponse, opts: { canWrite?: boolean; wired?: boolean } = {}) => {
  const html = renderToStaticMarkup(createElement(AttentionSurface, { data, nowMs: NOW.getTime(), canWrite: opts.canWrite ?? false, onOpenWorkspace: opts.wired === false ? undefined : () => {} }));
  return { html, text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
};
const badgeWords = (html: string) => [...html.matchAll(/<span class="text-xs font-medium">([^<]*)<\/span>/g)].map((m) => m[1]);
const REASSURING = /healthy|all clear|all good|everything is|no issues|operating normally/i;

function main() {
  console.log("1. first frame");
  {
    const html = renderToStaticMarkup(createElement(AttentionBlock, {}));
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    check("one surface titled Attention required, loading", (html.match(/<section/g) ?? []).length === 1 && text.includes("Attention required") && /role="status"/.test(html));
    check("no row, no verdict, no count", badgeWords(html).length === 0 && !/\d/.test(text));
  }

  console.log("2. server order, never re-sorted");
  {
    const data = response();
    const { html } = render(data);
    const labels = [...html.matchAll(/aria-label="Expand ([^"]+)"/g)].map((m) => m[1]);
    check("rows render in the server's order", labels.join(",") === data.items.map((i) => i.entity.label).join(","), labels.join(","));
    check("filter SELECTS and preserves order", filterItems(data.items, "critical").map((i) => i.id).join(",") === data.items.filter((i) => i.severity === "critical").map((i) => i.id).join(","));
    check("count pill carries the row count", new RegExp(`>${data.items.length}</span>`).test(html));
  }

  console.log("3. severity words, six columns, md: collapse");
  {
    const { html, text } = render(response());
    const words = badgeWords(html);
    check("every row leads with a severity WORD", words.every((w) => ["Critical", "Error", "Warning", "Info"].includes(w)) && words.length === response().items.length, words.join(","));
    for (const h of ["Severity", "Entity", "Problem", "Since", "Evidence", "Action"]) check(`column "${h}"`, text.includes(h));
    check("header is hidden below md and a grid above", /class="mb-1 hidden items-center gap-3 border-b px-1 pb-2 md:grid"/.test(html));
    check("the table owns horizontal scroll", html.includes('class="overflow-x-auto"'));
    check("dropped columns are md:block, the problem stays visible below md", /hidden md:block/.test(html) && /md:hidden/.test(html));
    check("a PillGroup filters by severity", /role="group" aria-label="Filter by severity"/.test(html) && /aria-pressed="true"/.test(html));
    check("no coral-500/600", !/--coral-(5|6)00/.test(html));
  }

  console.log("4. empty state");
  {
    const empty = response({}, { connections: { total: 1, counts: { HEALTHY: 1, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0 }, unhealthy: [], retired: { revoked: 0, ownerInactive: 0 } }, jobs: { jobs: [] }, providers: inputs.providers, resources: inputs.resources, alerts: { latest: null, titles: {} }, incidents: { items: [], activeTotal: 0, truncated: false } });
    const { html, text } = render(empty);
    check("says how many authorities were checked and when", text.includes("Nothing needs attention — 6 authorities checked at 2026-10-14 12:00 UTC."), text);
    check("…as a status, not a verdict", /role="status"/.test(html) && badgeWords(html).length === 0);
    check("never reads as healthy", !REASSURING.test(text.replace(ATTENTION_FOOTNOTE, "")), text);
  }

  console.log("5. a failed authority is announced");
  {
    const partial = response({}, { ...inputs, jobs: null, incidents: null });
    const { html, text } = render(partial);
    check("alert names the readers that could not be asked", /role="alert"/.test(html) && text.includes("2 authorities could not be asked (job-health, incidents)"), text);
    check("the other rows still render", text.includes("Chase"));
    const emptyButFailed = response({}, { connections: { total: 0, counts: { HEALTHY: 0, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0 }, unhealthy: [], retired: { revoked: 0, ownerInactive: 0 } }, jobs: null, providers: null, resources: null, alerts: null, incidents: null });
    const r2 = render(emptyButFailed);
    check("an empty list beside failed readers counts only the ones that answered", r2.text.includes("1 authority checked") && r2.text.includes("5 authorities could not be asked"), r2.text);
  }

  console.log("6. history is apart and labelled");
  {
    const { html, text } = render(response());
    check("heading names it historical with the window", text.includes("Recent alert firings (historical, last 10 evaluations)"));
    check("the historical firing is listed under the heading, not as a row", text.indexOf("HISTORICAL-ONLY") > text.indexOf("Recent alert firings") && !/aria-label="Expand [^"]*HISTORICAL/.test(html));
    check("the historical firing adds no severity badge (badges = rows)", badgeWords(html).length === response().items.length, badgeWords(html).join(","));
    check("only the LATEST-run breach is a row", [...html.matchAll(/aria-label="Expand ([^"]+)"/g)].some((m) => m[1] === "Repeated job failures"));
    check("footnote keeps the two clocks apart", text.includes(ATTENTION_FOOTNOTE));
    const none = render(response({ recentFirings: { runs: 0, newestEvaluatedAt: null, oldestEvaluatedAt: null, count: 0, items: [] } }));
    check("no evaluation recorded is worded, not blank", none.text.includes("no evaluation recorded"));
  }

  console.log("7. write actions follow canWrite; run-now is a doorway");
  {
    const ro = render(response(), { canWrite: false });
    check("READ: no Resync / Request reauthorization button", !/aria-label="Resync /.test(ro.html) && !/aria-label="Request reauthorization /.test(ro.html));
    const rw = render(response(), { canWrite: true });
    check("WRITE: Resync and Request reauthorization render for the Plaid ERROR row", /aria-label="Resync Chase"/.test(rw.html) && /aria-label="Request reauthorization Chase"/.test(rw.html));
    check("WRITE: a wallet row gets no Plaid write", !/aria-label="Resync Wallet/.test(rw.html));
    check("run-now renders as a doorway to Jobs, never a POST", /Run from Jobs/.test(rw.text) && !/run-now/.test(strip("components/platform/widgets/overview/AttentionBlock.tsx").replace(/"run-now"/g, "")));
    check("the only POSTs are the two existing connection routes", /connections\/\$\{action\.connectionId\}\/\$\{path\}/.test(strip("components/platform/widgets/overview/AttentionBlock.tsx")));
  }

  console.log("8. evidence");
  {
    const { html } = render(response());
    check("an execution opens the inspection panel", /aria-label="Inspect execution …abc123 for Chase · Checking"/.test(html));
    check("a doorway is labelled from the registry", /Open Providers — evidence for Chase/.test(html) && /Open Jobs — evidence for sync-banks/.test(html));
    const unwired = render(response(), { wired: false });
    check("unwired host: doorways become plain labels, the inspect button stays", !/Open Providers — evidence/.test(unwired.html) && /Inspect execution/.test(unwired.html));
  }

  console.log("9. the row expansion");
  {
    const item = response().items[0];
    const html = renderToStaticMarkup(createElement(AttentionRowDetail, { item, nowMs: NOW.getTime(), canWrite: false, busy: false, onOpenWorkspace: () => {}, onSelectExecution: () => {}, onWrite: () => {} }));
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    check("carries Since · Evidence · Action for below-md", ["Since", "Evidence", "Action"].every((l) => text.includes(l)) && /md:hidden/.test(html));
    check("carries the basis", text.includes(`Basis: ${item.basis}`));
  }

  console.log("10. privacy and purity");
  {
    const { html } = render(response(), { canWrite: true });
    check("no email-shaped string in the markup", !/[\w.+-]+@[\w-]+\.[\w.]+/.test(html));
    check("the Plaid row identifies by institution, the wallet by an opaque tail", html.includes("Chase") && html.includes("Wallet …abc123"));
    const src = strip("components/platform/widgets/overview/AttentionBlock.tsx");
    check("exactly one read, a string literal", (src.match(/useWidgetFetch</g) ?? []).length === 1 && src.includes('useWidgetFetch<AttentionResponse>("/api/platform/platform-ops/attention")'));
    check("no sort in the block (one ordering authority)", !/\.sort\(/.test(src));
    check("imports no reader or server module", !/@\/lib\/platform\/ops\/attention"|@\/lib\/db|server-only|customer-core/.test(src.replace(/import type[^;]+;/g, "")));
    check("no raw hex, no palette class", !/#[0-9a-fA-F]{3,8}\b/.test(src) && !/\b(?:bg|text|border)-(?:gray|blue|red|emerald|green)-\d{2,3}\b/.test(src));
  }

  if (failures > 0) { console.error(`\nattention-block.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nattention-block.test: all passed.");
}

main();
