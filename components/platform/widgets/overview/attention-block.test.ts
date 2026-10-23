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
import { AttentionBlock, AttentionRowDetail, AttentionSurface, UserImpactGroup } from "./AttentionBlock";
import { NO_USER_REFERENCE_REASON, buildAttention, buildUserImpact, type AttentionInputs, type UserImpactInputs } from "@/lib/platform/ops/attention-core";
import type { AttentionResponse } from "@/lib/platform/ops/attention";
import { ATTENTION_FOOTNOTE, IMPACT_FOOTNOTE, IMPACT_TITLE, filterItems } from "./attention-view";

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
      { source: "PLAID", id: "item_err", label: "Chase", status: "ERROR", errorCode: "ITEM_LOGIN_REQUIRED", healthState: "ERROR", lastSyncedAt: AGO(30), since: AGO(26), kind: "BANK", institution: null, network: null, overdueAfterHours: 24, neverSynced: false, availableActions: ["request-reauth", "resync"] },
      { source: "WALLET", id: "conn_w", label: "Wallet …abc123", status: "ACTIVE", errorCode: null, healthState: "STALE", lastSyncedAt: AGO(10), since: null, kind: "WALLET", institution: null, network: "ETH", overdueAfterHours: 6, neverSynced: false, availableActions: [] },
    ],
    retired: { revoked: 0, ownerInactive: 0 }, checkedAt: "2026-10-14T12:00:00.000Z", cap: 20, listedScope: "unhealthy",
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

// BETA V1 — the user-impact composition's inputs: one FAILED Plaid refresh, one
// PARTIAL wallet refresh, AI failure COUNTS, one failed Brief, and the SAME
// connection-health read (the ERROR row is not a reauth; a NEEDS_REAUTH row is
// added below where a test wants one).
const impactInputs: UserImpactInputs = {
  refresh: {
    rows: [
      { id: "exec_f1a2b3", runId: "run_1", plaidItemId: "item_zz9988", sourceKind: "PLAID_ITEM", sourceRef: null, network: null, trigger: "cron", profile: "incremental", startedAt: AGO(3), completedAt: AGO(3), durationMs: 1200, overallStatus: "FAILED", parentJobRunId: null, hasError: true, deploymentSha: null, errorSummary: "ITEM_LOGIN_REQUIRED", admissionReason: null, failureStage: "provider", failureCategory: "credential", outcome: "failed" },
      { id: "exec_p4c5d6", runId: "run_2", plaidItemId: null, sourceKind: "WALLET", sourceRef: "acct_ww7766", network: "ETH", trigger: "cron", profile: "incremental", startedAt: AGO(1), completedAt: AGO(1), durationMs: 800, overallStatus: "PARTIAL", parentJobRunId: null, hasError: true, deploymentSha: null, errorSummary: null, admissionReason: null, failureStage: null, failureCategory: null, outcome: "partial" },
    ],
    more: false,
  },
  ai: { windowHours: 24, returned: 40, failed: 2, timeouts: 0, rateLimited: 0, quota: 1, lastFailureAt: AGO(2), lastQuotaAt: AGO(5), checkedAt: NOW.toISOString() },
  brief: { counts: { rows: 3, generated: 2, failed: 1, inProgress: 0, empty: 0, versionStale: 0, coolingDown: 1, distinctSpaces: 3, distinctOwners: 3 }, rows: [
    { spaceRef: "…sp4455", briefDay: "2026-10-14", state: "FAILED", generationReason: null, versionStale: false, coolingDown: true, generatedAt: null, lastFailedAt: AGO(4), lastFailureReason: "QUOTA", model: null, generationVersion: null, invocation: null },
    { spaceRef: "…sp0001", briefDay: "2026-10-14", state: "GENERATED", generationReason: "daily", versionStale: false, coolingDown: false, generatedAt: AGO(6), lastFailedAt: null, lastFailureReason: null, model: "m", generationVersion: "v", invocation: null },
  ] },
  connections: inputs.connections,
};
const EMPTY_IMPACT: UserImpactInputs = { refresh: { rows: [], more: false }, ai: { windowHours: 24, returned: 10, failed: 0, timeouts: 0, rateLimited: 0, quota: 0, lastFailureAt: null, lastQuotaAt: null, checkedAt: NOW.toISOString() }, brief: { counts: { rows: 0, generated: 0, failed: 0, inProgress: 0, empty: 0, versionStale: 0, coolingDown: 0, distinctSpaces: 0, distinctOwners: 0 }, rows: [] }, connections: { total: 0, counts: { HEALTHY: 0, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0 }, unhealthy: [], retired: { revoked: 0, ownerInactive: 0 }, checkedAt: NOW.toISOString(), cap: 20, listedScope: "unhealthy" } };

function response(over: Partial<AttentionResponse> = {}, inp: AttentionInputs = inputs, impact: UserImpactInputs = impactInputs): AttentionResponse {
  const core = buildAttention(inp, NOW);
  return {
    userImpact: buildUserImpact(impact, NOW),
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
    const empty = response({}, { connections: { total: 1, counts: { HEALTHY: 1, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0 }, unhealthy: [], retired: { revoked: 0, ownerInactive: 0 }, checkedAt: "2026-10-14T12:00:00.000Z", cap: 20, listedScope: "unhealthy" }, jobs: { jobs: [] }, providers: inputs.providers, resources: inputs.resources, alerts: { latest: null, titles: {} }, incidents: { items: [], activeTotal: 0, truncated: false } });
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
    const emptyButFailed = response({}, { connections: { total: 0, counts: { HEALTHY: 0, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0 }, unhealthy: [], retired: { revoked: 0, ownerInactive: 0 }, checkedAt: "2026-10-14T12:00:00.000Z", cap: 20, listedScope: "unhealthy" }, jobs: null, providers: null, resources: null, alerts: null, incidents: null });
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

  console.log("11. BETA V1 · user-impacting failures — a separate composition, rendered first");
  {
    const data = response();
    const { html, text } = render(data);
    check("the group is titled and precedes the severity table", text.indexOf(IMPACT_TITLE) >= 0 && text.indexOf(IMPACT_TITLE) < text.indexOf("Severity"), text.slice(0, 400));
    check("users affected is withheld WITH the reason — never a figure invented from sources", text.includes("—") && text.includes(NO_USER_REFERENCE_REASON), text);
    check("the qualifier counts sources and facts over the window (3 AI facts = 2 FAILED + 1 QUOTA)", /3 sources affected · 6 facts · last 24 h/.test(text), text);
    check("every kind word is in the legend, zeros included", ["Refresh failed", "Refresh partial", "AI failure", "Brief failed", "Needs reauthorization"].every((w) => text.includes(w)));
    check("the distribution is word + count, with an accessible summary", /aria-label="Facts by kind · last 24 h: 1 Refresh failed, 1 Refresh partial, 3 AI failure, 1 Brief failed, 0 Needs reauthorization"/.test(html), html.match(/aria-label="Facts by kind[^"]*"/)?.[0]);
    for (const h of ["Kind", "Reference", "Problem", "When", "Evidence"]) check(`impact column "${h}"`, text.includes(h));
    check("impact rows render in the server's order (newest first)", (() => {
      const refs = [...html.matchAll(/<span class="text-xs[^"]*tabular-nums[^"]*">((?:item|account|space|connection) …[a-z0-9]+|no reference exposed)<\/span>/g)].map((m) => m[1]);
      return refs.join(",") === data.userImpact.rows.map((r) => (r.reference ? `${r.reference.kind} …${r.reference.tail}` : "no reference exposed")).join(",");
    })(), html);
    check("references are opaque tails typed by kind", text.includes("item …zz9988") && text.includes("account …ww7766") && text.includes("space …sp4455"));
    check("an AI roll-up row says it exposes no reference and carries its count", text.includes("no reference exposed") && /AI failure ×2/.test(text) && !/AI failure ×1\b/.test(text), text);
    check("a refresh row's evidence opens the execution panel", /aria-label="Inspect execution …f1a2b3 for item …zz9988"/.test(html) && /aria-label="Inspect execution …p4c5d6 for account …ww7766"/.test(html));
    check("an AI / Brief row's evidence is a registry-labelled doorway to AI", /Open AI — evidence for AI · provider call/.test(html) && /Open AI — evidence for Brief · generation/.test(html), html);
    check("impact kinds are not severity badges (the table's badge count is unchanged)", badgeWords(html).length === data.items.length, badgeWords(html).join(","));
    check("impact header is hidden below md and the cells carry their column word", /class="mb-1 hidden items-center gap-3 border-b px-1 pb-2 md:grid"/.test(html) && /text-\[10px\] uppercase tracking-wide text-\[var\(--text-faint\)\] md:hidden">Reference</.test(html));
    check("the identity rule is the group's hint, reachable by assistive technology (aria-label + title)", html.includes(`aria-label="${IMPACT_FOOTNOTE}"`) && html.includes(`title="${IMPACT_FOOTNOTE}"`), html.match(/aria-label="User-impacting[^"]*"/)?.[0]);
    check("no email, username or resolvable id in the group", !/[\w.+-]+@[\w-]+\.[\w.]+/.test(html) && !/item_zz9988|acct_ww7766|exec_f1a2b3|user …/.test(text), text);

    // Empty: a sentence counting readers, never a health claim; no bar, no rows.
    const empty = render(response({}, inputs, EMPTY_IMPACT));
    check("empty group says how many readers answered", empty.text.includes("No user-impacting failure recorded in the last 24 h — 4 readers answered."), empty.text);
    check("empty group shows users affected 0 with no reason, and no reference cell", /0 sources affected · 0 facts/.test(empty.text) && !/no reference exposed/.test(empty.text), empty.text);

    // Failed readers are named apart from the severity table's own alert.
    const partial = render(response({}, inputs, { ...impactInputs, ai: null, brief: null }));
    check("a failed impact reader is announced by name", partial.text.includes("2 user-impact readers could not be asked (ai-failures, brief-ops)"), partial.text);
    check("…and its rows are absent, the others present", !/AI failure ×/.test(partial.text) && partial.text.includes("item …zz9988"));

    // NEEDS_REAUTH mirrors the severity table's row with a connection reference.
    const reauth = render(response({}, inputs, { ...impactInputs, connections: { ...inputs.connections!, unhealthy: [...inputs.connections!.unhealthy, { source: "PLAID", id: "item_reauth1", label: "Wells Fargo", status: "NEEDS_REAUTH", errorCode: null, healthState: "NEEDS_REAUTH", lastSyncedAt: AGO(50), since: AGO(48), kind: "BANK", institution: null, network: null, overdueAfterHours: 24, neverSynced: false, availableActions: ["request-reauth"] }] } }));
    check("a NEEDS_REAUTH connection is an impact row with an opaque connection reference", reauth.text.includes("connection …eauth1") && reauth.text.includes("Connection · Wells Fargo") && /Open Providers — evidence for Connection · Wells Fargo/.test(reauth.html), reauth.text);

    // Floors are captioned inside the group.
    const floored = render(response({}, inputs, { ...impactInputs, refresh: { ...impactInputs.refresh!, more: true } }));
    check("a further page is a floor caption and the bar says so", floored.text.includes("the seam had a further page (a floor, not a total)") && /\(at least\)"/.test(floored.html), floored.text);

    // The group alone, as the host renders it (exported for this test).
    const alone = renderToStaticMarkup(createElement(UserImpactGroup, { impact: data.userImpact, nowMs: NOW.getTime(), onOpenWorkspace: () => {}, onSelectExecution: () => {} }));
    check("the group renders standalone with no section frame of its own (one frame = the surface)", !/var\(--shadow-e2\)/.test(alone) && alone.includes(IMPACT_TITLE));
  }

  if (failures > 0) { console.error(`\nattention-block.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nattention-block.test: all passed.");
}

main();
