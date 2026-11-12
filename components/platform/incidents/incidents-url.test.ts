/**
 * components/platform/incidents/incidents-url.test.ts  (PB-1 2B — deep link, KPI parity, rendering)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/incidents/incidents-url.test.ts
 *
 *   1. deep-link round trip: URL → state → URL is the identity for every kept
 *      value; unknown values are dropped; a refresh re-reads the same drawer;
 *   2. list total = KPI: the Operations KPI path IS the default view's list
 *      path, the default Ops incidents view is the broken-now preset, and the
 *      KPI and the list header print the same figure from one response;
 *   3. the timeline renders the events in the order given, each one;
 *   4. the Ops list / detail render no customer identity; the CS ones do.
 */

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SPACE_URL_PARAMS } from "@/lib/space/space-url";
import { PLATFORM_WORKSPACE_SCOPED_PARAMS } from "@/lib/space/use-platform-workspace-navigation";
import { getPlatformWorkspaceComposition } from "@/lib/platform/workspaces";
import { DEFAULT_SEARCH, MAX_INCIDENT_PAGE } from "@/lib/platform/incidents/intelligence/search-core";
import type { IncidentDetailDTO, IncidentListDTO, IncidentRowDTO } from "@/lib/platform/incidents/investigation-dto";
import {
  INCIDENTS_URL_PARAMS, INCIDENTS_WORKSPACE_ID, OPS_BROKEN_NOW_KPI_PATH, incidentsApiPath, incidentsUrlUpdate, readIncidentsUrl, statusOfView,
} from "./incidents-url";
import { EMPTY_LIFECYCLE_FORM, incidentTotalText, lifecycleBody, lifecycleFormValid, lifecyclePath, timelineText, whyLines } from "./incidents-model";
import { IncidentDetailSurface, IncidentListSurface, LifecycleFormFields, recoveryPath } from "./IncidentsLead";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
const NOW = Date.parse("2026-11-03T12:00:00Z");

console.log("1. deep-link round trip");
{
  const search = "workspace=platform-incidents&view=history&isev=error&iprov=PLAID&iop=transaction-persist&icode=UPSERT_ERROR&ifrom=2026-06-01&ito=2026-10-31&ipage=2&iid=inc_123";
  const s = readIncidentsUrl(search, "history", NOW);
  check("every value is read", s.query.status === "history" && s.query.severity === "error" && s.query.provider === "PLAID" && s.query.operation === "transaction-persist"
    && s.query.code === "UPSERT_ERROR" && s.query.from === "2026-06-01" && s.query.to === "2026-10-31" && s.query.page === 2 && s.selectedId === "inc_123", s);
  const back = new URLSearchParams(search);
  for (const [k, v] of Object.entries(incidentsUrlUpdate(s))) { if (v === null) back.delete(k); else back.set(k, v); }
  check("state → URL reproduces the same URL (refresh reopens the same list and drawer)", back.toString() === search, back.toString());
  const again = readIncidentsUrl(back.toString(), "history", NOW);
  check("…and reading it again gives the same state", JSON.stringify(again) === JSON.stringify(s));
  const closed = incidentsUrlUpdate({ ...s, selectedId: null, query: { ...DEFAULT_SEARCH, status: "history" } });
  check("closing the drawer + clearing filters deletes every key (clean URL)", INCIDENTS_URL_PARAMS.every((k) => closed[k] === null), closed);
  const junk = readIncidentsUrl("isev=loud&iprov=x;y&iop=Bad Op&icode=lower&ifrom=2026-13-40&ipage=-1&iid=../x", "open", NOW);
  check("unknown values are dropped (same parser as the route)", JSON.stringify(junk.query) === JSON.stringify(DEFAULT_SEARCH) && junk.selectedId === null, junk);
  check("a huge page is bounded", readIncidentsUrl("ipage=999999", "open", NOW).query.page === MAX_INCIDENT_PAGE);
  check("the view is the status preset", statusOfView("open") === "broken-now" && statusOfView("verify") === "needs-verification" && statusOfView("history") === "history" && statusOfView("summary") === "broken-now" && statusOfView(undefined) === "broken-now");
  check("every incidents param is a registered Space param and workspace-scoped (cleared on a workspace switch)",
    INCIDENTS_URL_PARAMS.every((k) => (SPACE_URL_PARAMS as readonly string[]).includes(k) && PLATFORM_WORKSPACE_SCOPED_PARAMS.includes(k)));
}

console.log("\n2. list total = KPI");
{
  const ops = getPlatformWorkspaceComposition("PLATFORM_OPS", INCIDENTS_WORKSPACE_ID);
  const cs = getPlatformWorkspaceComposition("CUSTOMER_SUCCESS", INCIDENTS_WORKSPACE_ID);
  check("Platform Ops has the incidents workspace; its DEFAULT view is Broken now", ops?.views?.[0]?.id === "open" && statusOfView(ops.views[0].id) === "broken-now");
  check("every Ops incidents view is the Ops lead; every CS investigation view is the CS lead (no section key ⇒ nothing to seed)",
    (ops?.views ?? []).every((v) => v.lead === "incidents-ops" && v.sections.length === 0)
    && (cs?.views ?? []).slice(1).every((v) => v.lead === "incidents-cs" && v.sections.length === 0) && cs?.views?.[0].sections.join() === "cs_sync_issues");
  const listPath = incidentsApiPath("ops", readIncidentsUrl("workspace=platform-incidents", ops?.views?.[0]?.id, NOW).query);
  check("the KPI path IS the default list's path (same route, same query)", OPS_BROKEN_NOW_KPI_PATH === listPath && listPath === "/api/platform/platform-ops/incidents?status=broken-now", { OPS_BROKEN_NOW_KPI_PATH, listPath });
  const lead = readFileSync("components/platform/leads/OperationsLead.tsx", "utf8");
  check("Operations fetches the KPI from OPS_BROKEN_NOW_KPI_PATH and opens INCIDENTS_WORKSPACE_ID (its default view)",
    /useSharedWidgetFetch<IncidentListDTO>\(OPS_BROKEN_NOW_KPI_PATH\)/.test(lead) && /onOpenWorkspace\(INCIDENTS_WORKSPACE_ID\)/.test(lead) && /incidentTotalText\(p\.incidents\.data\)/.test(lead));
  check("the list header prints the same incidentTotalText", /data-incidents-total>\{incidentTotalText\(list\.data\)\}/.test(readFileSync("components/platform/incidents/IncidentsLead.tsx", "utf8")));
  check("incidentTotalText marks a capped read as a floor", incidentTotalText({ total: 7, truncated: false }) === "7" && incidentTotalText({ total: 500, truncated: true }) === "500+");
}

const row = (o: Partial<IncidentRowDTO> = {}): IncidentRowDTO => ({
  id: "inc_1", state: "active", freshness: "current", closure: null, closureDerived: false, kind: "UPSERT_ERROR", provider: "PLAID", domain: "transactions",
  severity: "critical", effectiveSeverity: "critical", operation: "transaction-persist", label: "Transaction persistence failed", operationLabel: "Storing bank transactions",
  firstSeenAt: "2026-11-01T10:00:00.000Z", lastSeenAt: "2026-11-02T10:00:00.000Z", resolvedAt: null, occurrenceCount: 4, correlatedOccurrenceCount: 2,
  duplicateOf: null, subjectState: "LIVE", brokenNow: true, alertable: true, spread: { groupKey: "PLAID::transactions::transaction-persist", spread: "isolated", affectedSubjects: 1 },
  generation: 1, recovery: { proofCount: 0, mayAdvance: false, lastAttemptAt: null, lastSkipAt: null, evidenceKnown: true, evidenceBasis: "read" }, causeStatus: null, causeCode: null, ...o,
});
const ev = (id: string, at: string, type: string, extra: Record<string, unknown> = {}) => ({
  id, at, type, actorKind: "SYSTEM" as const, audited: false, fromState: null, toState: null, causeCode: null, actionCode: null, outcomeCode: null,
  refEventId: null, refreshExecutionId: null, jobRunId: null, ...extra,
});
const detail = (r: IncidentRowDTO, tier: "ops" | "cs"): IncidentDetailDTO => ({
  tier, incident: r, evidence: null, resolutionReasonCode: null,
  timeline: { source: "events", truncated: false, events: [
    ev("e1", "2026-11-01T10:00:00.000Z", "OBSERVED", { toState: "ACTIVE", refreshExecutionId: "exec_1" }),
    ev("e2", "2026-11-01T11:00:00.000Z", "CAUSE_HYPOTHESIZED", { causeCode: "PROVIDER_OUTAGE", actorKind: "OPERATOR", audited: true }),
    ev("e3", "2026-11-02T10:00:00.000Z", "OBSERVED"),
  ] },
  affected: { provider: "PLAID", institution: "Example Bank", itemCount: 1, accountCount: 2, subjectState: "LIVE", itemStatus: "ACTIVE" },
  related: [], recurrences: [], recurrencesTruncated: false,
  archive: { archived: false, archivedAt: null, archiveDueAt: null, retainedUntil: null },
  recovery: tier === "ops" ? [{ kind: "resync", connectionId: "item_1" }] : [{ kind: "refresh-customer", userId: "u_cust_0000000001" }],
  lifecycleActions: tier === "ops" ? ["acknowledge", "resolve"] : [],
  summary: { displayStatus: "active", customerActionRequired: false, remedy: "investigate", firstDetectedAt: r.firstSeenAt, lastObservedAt: r.lastSeenAt, resolvedAt: r.resolvedAt, ongoing: true },
  diagnosis: { providerErrorCode: null, providerErrorSource: null, providerErrorUnrecognised: false, attempts: null,
    recurrence: { generation: r.generation, previousIncidentId: null, earlierEpisodes: 0, truncated: false, lastRecoveredAt: null } },
  component: null,
  checkedAt: "2026-11-03T12:00:00.000Z",
});

console.log("\n3. the timeline renders the events in the order given, each one");
{
  const d = detail(row(), "ops");
  const html = renderToStaticMarkup(createElement(IncidentDetailSurface, { d, canWrite: true, onSelect: () => {}, onExecution: () => {}, onRecover: () => {} }));
  const types = [...html.matchAll(/data-event-type="([A-Z_]+)"/g)].map((m) => m[1]);
  check("three events, in stored order (none merged, none reordered)", types.join() === "OBSERVED,CAUSE_HYPOTHESIZED,OBSERVED", types);
  check("each event's coded fields are shown", html.includes("→ ACTIVE") && html.includes(timelineText(d.timeline.events[1]).parts[0]) && html.includes("by an operator (audited)"));
  check("a correlated execution is one click away (Ops)", (html.match(/>Execution</g) ?? []).length === 1);
  check("why is the module's verdict in words", whyLines(d).some((l) => l.startsWith("Broken now")) && html.includes("data-incident-why"));
  check("the recovery action renders only with write access", html.includes("Resync connection")
    && !renderToStaticMarkup(createElement(IncidentDetailSurface, { d, canWrite: false, onSelect: () => {}, onRecover: () => {} })).includes("data-incident-recovery"));
  check("recovery actions post to the EXISTING routes only",
    recoveryPath({ kind: "resync", connectionId: "a" }) === "/api/platform/platform-ops/connections/a/resync"
    && recoveryPath({ kind: "request-reauth", connectionId: "a" }) === "/api/platform/platform-ops/connections/a/request-reauth"
    && recoveryPath({ kind: "refresh-customer", userId: "u" }) === "/api/platform/customer-success/customers/u/refresh");
}

console.log("\n4. Ops renders no identity; CS does");
{
  const list = (r: IncidentRowDTO): IncidentListDTO => ({ tier: "ops", items: [r], total: 1, page: 1, pageSize: 25, truncated: false, scanned: 3, facets: { providers: ["PLAID"], operations: [], codes: [] }, checkedAt: "2026-11-03T12:00:00.000Z", fromClamped: false });
  const opsHtml = renderToStaticMarkup(createElement(IncidentListSurface, { data: list(row()), onSelect: () => {}, onPage: () => {} }));
  check("Ops list: every row is a button opening the drawer, no customer line", /data-incident-row="inc_1"/.test(opsHtml) && /aria-haspopup="dialog"/.test(opsHtml) && !opsHtml.includes("customer "));
  const opsDetail = renderToStaticMarkup(createElement(IncidentDetailSurface, { d: detail(row(), "ops"), canWrite: true, onSelect: () => {}, onRecover: () => {} }));
  check("Ops detail: no customer line", !/Customer |No attributed customer/.test(opsDetail));
  const csRow = row({ subjectUserId: "u_cust_0000000001", subjectRef: "user #0a1b2c3d" });
  const csHtml = renderToStaticMarkup(createElement(IncidentListSurface, { data: { ...list(csRow), tier: "cs" }, onSelect: () => {}, onPage: () => {} }));
  const csDetail = renderToStaticMarkup(createElement(IncidentDetailSurface, { d: detail(csRow, "cs"), canWrite: true, onSelect: () => {}, onRecover: () => {} }));
  check("CS list + detail name the attributed customer by PRIV-ref only, never the raw id (control)",
    csHtml.includes("data-incident-row-customer-ref") && csHtml.includes("Customer user #0a1b2c3d") && !csHtml.includes("u_cust_0000000001")
      && csDetail.includes("data-incident-customer-ref") && !csDetail.includes("u_cust_0000000001") && csDetail.includes("Refresh all for this customer"));
  const csNoRef = renderToStaticMarkup(createElement(IncidentListSurface, { data: { ...list(row({ subjectUserId: "u_cust_0000000001" })), tier: "cs" }, onSelect: () => {}, onPage: () => {} }));
  check("CS list row without a server ref ⇒ the fail-closed word, never the raw id", csNoRef.includes("Customer customer") && !csNoRef.includes("u_cust_0000000001"));
  const empty = renderToStaticMarkup(createElement(IncidentListSurface, { data: { ...list(row()), items: [], total: 30, page: 3 }, onSelect: () => {}, onPage: () => {} }));
  check("a page past the end says so and keeps the pager", empty.includes("No incidents on this page.") && empty.includes("data-pager"));
}

console.log("\n5. PB-1 S6 — lifecycle actions: Ops + write only, confirm-first, reason fields, never CS");
{
  const noop = () => {};
  const ops = renderToStaticMarkup(createElement(IncidentDetailSurface, { d: detail(row(), "ops"), canWrite: true, onSelect: noop, onRecover: noop, onLifecycle: noop }));
  check("Ops + write: Acknowledge… and Resolve… openers (dialog), never an inline commit",
    /data-lifecycle-action="acknowledge"[^>]*>Acknowledge…</.test(ops) && /data-lifecycle-action="resolve"[^>]*>Resolve…</.test(ops)
    && (ops.match(/data-lifecycle-action="[a-z]+"[^>]*aria-haspopup="dialog"|aria-haspopup="dialog"[^>]*data-lifecycle-action/g) ?? []).length === 2);
  const readOnly = renderToStaticMarkup(createElement(IncidentDetailSurface, { d: detail(row(), "ops"), canWrite: false, onSelect: noop, onRecover: noop, onLifecycle: noop }));
  check("Ops read-only: no buttons, the actions are named with the access they need", !readOnly.includes("data-lifecycle-action") && readOnly.includes("Acknowledge · Resolve — requires write access."));
  const cs = renderToStaticMarkup(createElement(IncidentDetailSurface, { d: { ...detail(row({ subjectUserId: "u_cust_0000000001" }), "cs"), lifecycleActions: ["acknowledge", "resolve"] }, canWrite: true, onSelect: noop, onRecover: noop }));
  check("CS: no lifecycle control even if the DTO named one (no handler is passed on the CS tier)", !cs.includes("data-incident-lifecycle") && !cs.includes("Acknowledge"));
  const ackOnly = renderToStaticMarkup(createElement(IncidentDetailSurface, { d: { ...detail(row(), "ops"), lifecycleActions: ["resolve"] }, canWrite: true, onSelect: noop, onRecover: noop, onLifecycle: noop }));
  check("only the actions the module offers are rendered", !ackOnly.includes('data-lifecycle-action="acknowledge"') && ackOnly.includes('data-lifecycle-action="resolve"'));
  const form = renderToStaticMarkup(createElement(LifecycleFormFields, { action: "resolve", form: EMPTY_LIFECYCLE_FORM, onChange: noop }));
  check("the resolve form asks for a resolution, a reason and a REQUIRED note (≤280)", form.includes("Choose a resolution…") && form.includes("Note (required)") && form.includes('maxLength="280"'));
  check("acknowledge needs only the reason; resolve needs a resolution code and a note",
    lifecycleFormValid("acknowledge", EMPTY_LIFECYCLE_FORM) && !lifecycleFormValid("resolve", EMPTY_LIFECYCLE_FORM)
    && !lifecycleFormValid("resolve", { ...EMPTY_LIFECYCLE_FORM, resolutionReason: "OPERATOR_FIXED" })
    && lifecycleFormValid("resolve", { ...EMPTY_LIFECYCLE_FORM, resolutionReason: "OPERATOR_FIXED", note: "checked" })
    && !lifecycleFormValid("acknowledge", { ...EMPTY_LIFECYCLE_FORM, note: "x".repeat(281) }));
  check("bodies match the route's parser", JSON.stringify(lifecycleBody("acknowledge", EMPTY_LIFECYCLE_FORM)) === '{"reason":{"code":"INCIDENT"}}'
    && JSON.stringify(lifecycleBody("resolve", { auditReason: "INCIDENT", resolutionReason: "OPERATOR_FIXED", note: " ok " })) === '{"resolutionReasonCode":"OPERATOR_FIXED","reason":{"code":"INCIDENT","note":"ok"}}');
  check("lifecycle actions post to the two Ops routes", lifecyclePath("acknowledge", "a b") === "/api/platform/platform-ops/incidents/a%20b/acknowledge"
    && lifecyclePath("resolve", "x") === "/api/platform/platform-ops/incidents/x/resolve");
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nincidents-url.test: all passed.");
