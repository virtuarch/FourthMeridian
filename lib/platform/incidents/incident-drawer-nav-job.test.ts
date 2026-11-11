/**
 * lib/platform/incidents/incident-drawer-nav-job.test.ts  (Incident drawer PR-A — owner 11-08, S2 09gg a)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/incident-drawer-nav-job.test.ts
 *
 *   1. investigate reads the NEWEST occurrence's evidence summary (one row) and
 *      keeps only jobName / jobRunId strings; a bad / failed read ⇒ no component;
 *   2. the DTO `component`: JOB_LABELS word, an unknown job ⇒ a generic word
 *      (never the raw ledger name), jobRunId on the Ops tier ONLY, key allowlist;
 *   3. the resolver: an unfiltered "Jobs (all)" link only for a job incident,
 *      labelled unfiltered; never on the CS drawer;
 *   4. the drawer: a Summary "Job" stamp; the CS-only "Open customer profile"
 *      button (absent on Ops even when a handler is passed); the PRIV-ref in
 *      place of the raw customer id; no user id in any href;
 *   5. wiring: cs_customers is HOSTED (never inline) on the CS incidents views
 *      only; the profile variant renders the panel alone and re-reads per open.
 */

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UserRole, type PlatformArea } from "@prisma/client";
import { createIncidentAccessors, newestOccurrenceComponent, type IncidentFactsReader } from "./intelligence/index";
import { incidentAudienceFor, type CsToken, type OpsToken } from "./intelligence/audience";
import { incidentComponentOf, incidentDetailDTO, incidentListDTO, UNKNOWN_JOB_LABEL, type IncidentDetailDTO } from "./investigation-dto";
import {
  INCIDENT_NAVIGATION_TARGETS, JOBS_LINK_LABEL, JOBS_LINK_NOTE, csIncidentNavigationLinks, incidentNavigationLinks,
  type IncidentNavigationInput, type IncidentNavigationResolver,
} from "./related-navigation";
import { JOB_LABELS } from "@/components/platform/ops-visual/job-catalog";
import { CUSTOMER_PROFILE_HOST_KEY, IncidentDetailSurface, componentLine } from "@/components/platform/incidents/IncidentsLead";
import { metricAccessFor, type MetricAccessToken } from "@/lib/platform/intelligence/metrics/access";
import { resolveNavigationTarget } from "@/lib/platform/intelligence/navigation/access";
import { NAVIGATION_TARGETS } from "@/lib/platform/intelligence/navigation/registry";
import { PLATFORM_AREA_WORKSPACES } from "@/lib/platform/workspaces";
import { opaqueUserRefWith } from "@/lib/platform/opaque-user-ref";
import type { IncidentInvestigation } from "./intelligence/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const NOW = new Date("2026-11-11T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const USER_ID = "u_cust_drawer_0000000001";
const ITEM = { id: "item_drawer", status: "ACTIVE", errorCode: null, userId: USER_ID, institutionName: "Example Bank" };
const INCIDENT = {
  id: "inc_drawer_job", kind: "UPSERT_ERROR", provider: "PLAID", plaidItemId: ITEM.id, financialAccountId: null, plaidTransactionId: null,
  detail: { stage: "transactions-sync" }, resolved: false, incidentKey: "v1::PLAID::item:item_drawer::transactions::sync", previousIncidentId: null,
  createdAt: hoursAgo(5), firstOccurredAt: hoursAgo(5), lastOccurredAt: hoursAgo(1), resolvedAt: null, resolutionKind: null, resolutionReasonCode: null,
  lifecycleState: null, acknowledgedAt: null, recoveringSince: null, archivedAt: null, subjectUserId: USER_ID, causeStatus: null, causeCode: null,
  resolutionEvidence: null, _count: { occurrences: 3 },
};

type OccArgs = { where?: { syncIssueId?: unknown }; orderBy?: unknown; take?: number; select?: Record<string, unknown> };
let occurrenceRows: unknown[] = [];
let occurrenceThrows = false;
const occurrenceCalls: OccArgs[] = [];
const client: IncidentFactsReader = {
  syncIssue: { findMany: (async (a: { where?: { id?: unknown } }) => (a.where && "id" in a.where && a.where.id === INCIDENT.id ? [INCIDENT] : [])) as never },
  syncIssueOccurrence: {
    findMany: (async (a: OccArgs) => {
      // Only the component read names a single syncIssueId (string); the account roll-up reads `in`.
      if (typeof a.where?.syncIssueId === "string") {
        occurrenceCalls.push(a);
        if (occurrenceThrows) throw new Error("db down");
        return occurrenceRows;
      }
      return [];
    }) as never,
    groupBy: (async () => []) as never,
  },
  syncIssueArchive: { findMany: (async () => []) as never },
  syncIssueRelation: { findMany: (async () => []) as never },
  syncIssueEvent: { findMany: (async () => []) as never },
  financialAccount: { findMany: (async () => []) as never },
  plaidItem: { findMany: (async () => [ITEM]) as never },
  latestAttempts: (async () => []) as never,
};
const acc = createIncidentAccessors(client);
const ops = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "PLATFORM_OPS", level: "READ" } as never }) as OpsToken;
const cs = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "CUSTOMER_SUCCESS", level: "READ" } as never }) as CsToken;

const tokenFor = (area: PlatformArea): MetricAccessToken => metricAccessFor({ user: { role: UserRole.USER }, grant: { area, level: "READ" } as never })!;
const PO = tokenFor("PLATFORM_OPS");
const CS = tokenFor("CUSTOMER_SUCCESS");
const opsResolver = (t: MetricAccessToken): IncidentNavigationResolver => (id, p) => resolveNavigationTarget("PLATFORM_OPS", t, id, p, { now: NOW });
const csResolver = (t: MetricAccessToken): IncidentNavigationResolver => (id, p) => resolveNavigationTarget("CUSTOMER_SUCCESS", t, id, p, { now: NOW });
const hrefsOf = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

async function main(): Promise<void> {
  console.log("1. investigate reads the newest occurrence's evidence summary");
  occurrenceRows = [{ evidenceSummary: { executionId: "ex_1", runId: "run_1", jobRunId: "jr_abc123", jobName: "sync-banks", stage: "transactions-sync" } }];
  const inv = await acc.investigate(ops, INCIDENT.id, { now: NOW });
  check("investigate finds it", inv !== null);
  if (!inv) process.exit(1);
  const call = occurrenceCalls[occurrenceCalls.length - 1];
  check("ONE row, newest first, the evidence summary column only",
    call?.take === 1 && JSON.stringify(call.orderBy) === JSON.stringify([{ observedAt: "desc" }, { id: "desc" }]) && Object.keys(call.select ?? {}).join() === "evidenceSummary" && call.where?.syncIssueId === INCIDENT.id, call);
  check("component = the job name + run id (raw facts; the DTO words them)", JSON.stringify(inv.component) === JSON.stringify({ jobName: "sync-banks", jobRunId: "jr_abc123" }), inv.component);
  check("a summary naming no job ⇒ null", (await newestOccurrenceComponent("x", { syncIssueOccurrence: { findMany: (async () => [{ evidenceSummary: { jobName: null, stage: "s" } }]) as never, groupBy: (async () => []) as never } })) === null);
  check("a non-object / array summary ⇒ null",
    (await newestOccurrenceComponent("x", { syncIssueOccurrence: { findMany: (async () => [{ evidenceSummary: "sync-banks" }]) as never, groupBy: (async () => []) as never } })) === null
    && (await newestOccurrenceComponent("x", { syncIssueOccurrence: { findMany: (async () => [{ evidenceSummary: ["sync-banks"] }]) as never, groupBy: (async () => []) as never } })) === null);
  check("no occurrence ⇒ null", (await newestOccurrenceComponent("x", { syncIssueOccurrence: { findMany: (async () => []) as never, groupBy: (async () => []) as never } })) === null);
  occurrenceThrows = true;
  const failed = await acc.investigate(ops, INCIDENT.id, { now: NOW });
  occurrenceThrows = false;
  check("a failed occurrence read never hides the incident: served, component null", failed !== null && failed.component === null);

  console.log("\n2. the DTO component");
  const d = incidentDetailDTO(inv, "ops", NOW);
  check("Ops: the JOB_LABELS word + run id + operation / domain from the verdict",
    d.component?.jobLabel === JOB_LABELS["sync-banks"] && d.component.jobRunId === "jr_abc123" && d.component.domain === inv.verdict.domain
      && (inv.verdict.operationLabel ? d.component.operationLabel === inv.verdict.operationLabel : d.component.operationLabel === undefined), d.component);
  check("component keys are a subset of the allowlist", Object.keys(d.component ?? {}).every((k) => ["jobLabel", "jobRunId", "operationLabel", "domain"].includes(k)), Object.keys(d.component ?? {}));
  check("Ops: no subjectRef key, no customer id", !("subjectRef" in d) && !JSON.stringify(d).includes(USER_ID));
  const csInv = await acc.investigate(cs, INCIDENT.id, { now: NOW });
  const cd = incidentDetailDTO(csInv!, "cs", NOW, { subjectRefOf: (u) => opaqueUserRefWith(u, "test-secret") });
  check("CS: the same label, NO jobRunId (Ops only, S2)", cd.component?.jobLabel === JOB_LABELS["sync-banks"] && !("jobRunId" in (cd.component ?? {})) && !JSON.stringify(cd).includes("jr_abc123"));
  check("CS: subjectRef is the opaque PRIV-ref (user #<8 hex>), never the id", /^user #[0-9a-f]{8}$/.test(cd.subjectRef ?? "") && !(cd.subjectRef ?? "").includes(USER_ID), cd.subjectRef);
  check("CS without a ref function ⇒ the fail-closed word, never the id", incidentDetailDTO(csInv!, "cs", NOW).subjectRef === "customer");
  const refOf = (u: string) => opaqueUserRefWith(u, "test-secret");
  const searchResult = { items: [csInv!.verdict], total: 1, page: 1, pageSize: 25, truncated: false, scanned: 1, facets: { providers: [], operations: [], codes: [] } } as never;
  const csList = incidentListDTO(searchResult, "cs", NOW, false, { subjectRefOf: refOf });
  check("CS list rows carry the same PRIV-ref as the drawer", csList.items[0].subjectRef === cd.subjectRef && /^user #[0-9a-f]{8}$/.test(csList.items[0].subjectRef ?? ""));
  check("CS list rows without a ref function ⇒ the fail-closed word", incidentListDTO(searchResult, "cs", NOW, false).items[0].subjectRef === "customer");
  const opsList = incidentListDTO({ ...(searchResult as object), items: [inv.verdict] } as never, "ops", NOW, false, { subjectRefOf: refOf });
  check("Ops list rows: no subjectRef, no subjectUserId, no id", !("subjectRef" in opsList.items[0]) && !("subjectUserId" in opsList.items[0]) && !JSON.stringify(opsList).includes(USER_ID));
  const withJob = (jobName: string | null, jobRunId: string | null = null) => ({ ...inv, component: jobName === null && jobRunId === null ? null : { jobName, jobRunId } }) as IncidentInvestigation;
  const unknown = incidentComponentOf(withJob("internal-secret-job-x"), "ops");
  check("an unknown job ⇒ the generic word, never the raw ledger name",
    unknown?.jobLabel === UNKNOWN_JOB_LABEL && !JSON.stringify(unknown).includes("internal-secret-job-x") && !JSON.stringify(incidentDetailDTO(withJob("internal-secret-job-x"), "ops", NOW)).includes("internal-secret-job-x"));
  check("a prototype key is not a job label", incidentComponentOf(withJob("constructor"), "ops")?.jobLabel === UNKNOWN_JOB_LABEL && incidentComponentOf(withJob("__proto__"), "ops")?.jobLabel === UNKNOWN_JOB_LABEL);
  check("every registered job maps to its own word", Object.entries(JOB_LABELS).every(([k, w]) => incidentComponentOf(withJob(k), "ops")?.jobLabel === w));
  check("a malformed run id is dropped (Ops)", !("jobRunId" in (incidentComponentOf(withJob("sync-banks", "run id with spaces/../"), "ops") ?? {})));
  check("no job ⇒ component null (both tiers)", incidentComponentOf(withJob(null), "ops") === null && incidentDetailDTO(withJob(null), "cs", NOW).component === null);

  console.log("\n3. the resolver's Jobs link");
  const input = (component: IncidentNavigationInput["component"]): IncidentNavigationInput => ({
    verdict: { id: "inc_cur", provider: "PLAID", state: "active", recurrence: { previousIncidentId: null }, subjectUserId: USER_ID } as unknown as IncidentNavigationInput["verdict"],
    itemCount: 1, recurrences: [], component,
  });
  const T = NAVIGATION_TARGETS.find((t) => t.id === INCIDENT_NAVIGATION_TARGETS.jobs);
  check("the Jobs target is a real OPS-tier view that takes NO param (so the link is unfiltered)", !!T && T.tier === "OPS" && T.viewId === "jobs" && T.params.length === 0, T);
  const jobLinks = incidentNavigationLinks(input({ jobName: "sync-banks" }), opsResolver(PO));
  const jobs = jobLinks.filter((l) => l.kind === "jobs");
  check("a job incident ⇒ exactly one Jobs link", jobs.length === 1, jobLinks.map((l) => l.kind));
  check("…its href is resolveNavigationTarget's output, verbatim, with no params",
    jobs[0]?.href === resolveNavigationTarget("PLATFORM_OPS", PO, INCIDENT_NAVIGATION_TARGETS.jobs, undefined, { now: NOW })?.href
      && [...new URL(jobs[0].href, "https://x").searchParams.keys()].every((k) => ["workspace", "view"].includes(k)), jobs[0]?.href);
  check("…labelled unfiltered (\"Jobs (all)\") and the note says no per-job filter", jobs[0]?.label === JOBS_LINK_LABEL && JOBS_LINK_LABEL === "Jobs (all)" && /no per-job/.test(jobs[0]?.note ?? "") && jobs[0]?.note === JOBS_LINK_NOTE);
  check("…not an in-place incident link", jobs[0]?.incidentId === null && jobs[0]?.viewId === null);
  check("not a job incident ⇒ no Jobs link", [null, undefined, { jobName: null }, { jobName: "" }].every((c) => !incidentNavigationLinks(input(c), opsResolver(PO)).some((l) => l.kind === "jobs")));
  check("a CS token on the CS surface never gets the Jobs link", !incidentNavigationLinks(input({ jobName: "sync-banks" }), csResolver(CS)).some((l) => l.kind === "jobs"));
  const csDto = { ...cd, navigation: undefined } as IncidentDetailDTO;
  check("the CS drawer's links never include Jobs or a customer profile", csIncidentNavigationLinks(csDto, csResolver(CS)).every((l) => l.kind !== "jobs" && !/customer/i.test(l.label)));
  check("no resolver link is a customer-profile link (Ops or CS)",
    [...jobLinks, ...incidentNavigationLinks(input({ jobName: "sync-banks" }), csResolver(CS))].every((l) => !/profile/i.test(l.label) && !l.href.includes(USER_ID)));

  console.log("\n4. the drawer");
  const opsDetail: IncidentDetailDTO = { ...d, navigation: jobLinks };
  const opsHtml = renderToStaticMarkup(createElement(IncidentDetailSurface, { d: opsDetail, canWrite: true, onSelect: () => {}, onRecover: () => {}, onOpenCustomer: () => {} }));
  check("Summary carries the Job stamp with the label", /data-incident-component[^>]*>.*?>Job<\/dt><dd[^>]*>Bank sync<\/dd>/.test(opsHtml) && opsHtml.indexOf("data-incident-component") < opsHtml.indexOf("data-incident-diagnosis"));
  check("the Jobs link renders, unfiltered label", opsHtml.includes(">Jobs (all)<"));
  check("Ops: NO \"Open customer profile\" even when a handler is passed", !opsHtml.includes("data-open-customer-profile") && !/Open customer profile/.test(opsHtml));
  check("Ops: no customer line", !opsHtml.includes("data-incident-customer"));
  check("Technical details (behind a disclosure) carries the run id on Ops", componentLine(d.component!).includes("run jr_abc123") && opsHtml.includes("data-incident-component-detail"));
  const csLinks = csIncidentNavigationLinks(cd, csResolver(CS));
  const csDetail: IncidentDetailDTO = { ...cd, navigation: csLinks };
  const csHtml = renderToStaticMarkup(createElement(IncidentDetailSurface, { d: csDetail, canWrite: true, onSelect: () => {}, onRecover: () => {}, onOpenCustomer: () => {} }));
  check("CS: the PRIV-ref is shown, the raw customer id is NOT rendered anywhere", csHtml.includes(`Customer ${cd.subjectRef}`) && !csHtml.includes(USER_ID));
  check("CS: the \"Open customer profile\" button (a button, never a link)", /<button[^>]*data-open-customer-profile[^>]*>\s*Open customer profile/.test(csHtml) && !/<a[^>]*data-open-customer-profile/.test(csHtml));
  check("CS: no handler (profile not hosted) ⇒ no button", !renderToStaticMarkup(createElement(IncidentDetailSurface, { d: csDetail, canWrite: true, onSelect: () => {}, onRecover: () => {} })).includes("data-open-customer-profile"));
  check("CS: no run id rendered", !csHtml.includes("jr_abc123"));
  check("no user id in any rendered href (Ops or CS)", [...hrefsOf(opsHtml), ...hrefsOf(csHtml)].every((h) => !h.includes(USER_ID) && !h.includes("u_cust")), [...hrefsOf(opsHtml), ...hrefsOf(csHtml)]);
  const unattributed = renderToStaticMarkup(createElement(IncidentDetailSurface, { d: { ...csDetail, incident: { ...csDetail.incident, subjectUserId: null }, subjectRef: null }, canWrite: true, onSelect: () => {}, onRecover: () => {}, onOpenCustomer: () => {} }));
  check("CS, no attributed customer ⇒ says so, no button", unattributed.includes("No attributed customer") && !unattributed.includes("data-open-customer-profile"));
  check("390px: the customer row wraps (flex-wrap, min-w-0, break-words); the button meets the 44px touch target (min-h-11)",
    /data-incident-customer[^>]*/.test(csHtml) && /class="[^"]*flex-wrap[^"]*min-w-0|class="[^"]*min-w-0[^"]*flex-wrap/.test(csHtml) && /min-h-11[^"]*"[^>]*data-open-customer-profile|class="[^"]*min-h-11[^"]*"[^>]*aria-haspopup="dialog" data-open-customer-profile/.test(csHtml));

  console.log("\n5. wiring");
  const code = (s: string) => s.replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
  const lead = code(readFileSync("components/platform/incidents/IncidentsLead.tsx", "utf8"));
  check("the drawer opens the profile ONLY through requestOpenCustomer (in-page event), CS tier + hosted only",
    /onOpenCustomer=\{tier === "cs" && customerProfileHosted \? requestOpenCustomer : undefined\}/.test(lead)
      && /const customerProfileHosted = tier === "cs" && hasHosted\(CUSTOMER_PROFILE_HOST_KEY\)/.test(lead));
  check("the profile panel is hosted in the \"customer-profile\" variant", /renderHosted\(CUSTOMER_PROFILE_HOST_KEY, undefined, "customer-profile"\)/.test(lead) && CUSTOMER_PROFILE_HOST_KEY === "cs_customers");
  check("the drawer still has exactly one href attribute (the resolved link's)", [...lead.matchAll(/\bhref=\{([^}]*)\}/g)].map((m) => m[1].trim()).join() === "l.href");
  check("the drawer writes no URL / history for the profile (its only customers/ path is the existing Refresh-all POST)",
    !/pushState|replaceState/.test(lead) && (lead.match(/customer-success\/customers\//g) ?? []).length === 1
      && /`\/api\/platform\/customer-success\/customers\/\$\{encodeURIComponent\(a\.userId\)\}\/refresh`/.test(lead));
  const nav = code(readFileSync("lib/platform/incidents/related-navigation.ts", "utf8"));
  check("the resolver never offers the profile", !/requestOpenCustomer|cs-open-customer|customer-profile|customers\//.test(nav));
  type V = { id: string; hosted?: readonly string[]; hostedPanels?: Readonly<Record<string, string>>; sections: readonly unknown[] };
  const views = (area: string) => (PLATFORM_AREA_WORKSPACES as unknown as Record<string, readonly { workspaceId: string; sections: readonly string[]; views?: readonly V[] }[]>)[area] ?? [];
  const csInc = views("CUSTOMER_SUCCESS").find((w) => w.workspaceId === "platform-incidents");
  const opsInc = views("PLATFORM_OPS").find((w) => w.workspaceId === "platform-incidents");
  check("cs_customers is a PANEL-ONLY host (\"customer-profile\") on every CS incidents lead view — not inline, not composed",
    !!csInc?.views && csInc.views.filter((v) => v.id !== "summary").every((v) => v.hostedPanels?.cs_customers === "customer-profile" && !v.hosted?.includes("cs_customers") && !v.sections.includes("cs_customers"))
      && !csInc.sections.includes("cs_customers"));
  check("…so the CS incidents navigation targets gain no customers param group, section or metric",
    NAVIGATION_TARGETS.filter((t) => t.id.startsWith("CUSTOMER_SUCCESS:platform-incidents")).every((t) => !t.sections.includes("cs_customers") && !t.paramGroups.includes("cs-attention")));
  check("…and never on the Ops incidents views", !!opsInc?.views && opsInc.views.every((v) => !v.hostedPanels && !v.hosted?.includes("cs_customers") && !v.sections.includes("cs_customers")));
  const dash = code(readFileSync("components/platform/PlatformSpaceDashboard.tsx", "utf8"));
  check("the dashboard renders a panel-only key ONLY in its named variant (never the full list)",
    /if \(panelOnly\(key\) && variant !== hostedPanels!\[key\]\) return null;/.test(dash) && /hostedPanels=\{activeViewDef\?\.hostedPanels\}/.test(dash));
  const widget = code(readFileSync("components/platform/widgets/CsCustomersWidget.tsx", "utf8"));
  check("the profile variant renders the panel ALONE, before any list markup", /if \(profileOnly\) return profilePanel;/.test(widget) && widget.indexOf("if (profileOnly) return profilePanel;") < widget.indexOf('id="cs-customer-list"'));
  check("the profile variant reads no list and touches no URL", /if \(profileOnly\) return;\s*let alive = true;\s*\(async \(\) => \{ if \(alive\) await openFromUrl/.test(widget)
    && /profileOnly \? undefined : spaceUrl\.subscribe/.test(widget) && /if \(!profileOnly\) await loadList\(search, attention\)/.test(widget));
  check("every open request re-reads the audited detail route (fresh read + CUSTOMER_PROFILE_VIEWED each time)",
    /setOpenSeq\(\(n\) => n \+ 1\)/.test(widget) && /\}, \[selectedId, openSeq, loadDetail\]\);/.test(widget) && /fetch\(`\/api\/platform\/customer-success\/customers\/\$\{id\}`/.test(widget));
  // S2 09gi (required) — profileOnly registers NO attention-filter listener, never commits ?attention= and never reads the list.
  const filterEnd = widget.indexOf("}, [applyAttention, profileOnly]);");
  const filterBody = filterEnd > 0 ? widget.slice(widget.lastIndexOf("useEffect(() => {", filterEnd) + "useEffect(() => {".length, filterEnd) : "";
  check("profileOnly: the attention-filter effect returns before registering its listener",
    /^\s*if \(profileOnly\) return;\s*const onFilter/.test(filterBody) && filterBody.includes("addEventListener(CS_ATTENTION_FILTER_EVENT, onFilter)")
      && (widget.match(/addEventListener\(CS_ATTENTION_FILTER_EVENT/g) ?? []).length === 1, filterBody.slice(0, 120));
  const effects = [...widget.matchAll(/useEffect\(([\s\S]*?)\}?, \[([^\]]*)\]\);/g)].map((m) => ({ body: m[1], deps: m[2] }));
  const urlOrList = effects.filter((e) => /applyAttention|openFromUrl|loadList|spaceUrl\.(commit|subscribe)|CS_ATTENTION_FILTER_EVENT/.test(e.body));
  check("profileOnly: EVERY effect that can commit ?attention=, subscribe to the URL or read the list is gated on profileOnly",
    urlOrList.length === 3 && urlOrList.every((e) => /profileOnly/.test(e.body) && /\bprofileOnly\b/.test(e.deps)), urlOrList.map((e) => e.deps));
  check("profileOnly: an action re-reads the profile but never the list", /if \(!profileOnly\) await loadList\(search, attention\)/.test(widget));
  check("profileOnly: the commit / list-read call sites live only in list handlers (applyAttention, openFromUrl, the search form) — none rendered in the panel",
    (() => { const panel = widget.slice(widget.indexOf("const profilePanel = ("), widget.indexOf("if (profileOnly) return profilePanel;")); return !/spaceUrl\.commit|loadList\(|applyAttention\(|openFromUrl\(/.test(panel); })());

  // P3 (S2 approved) — the CS incidents LIST shows the PRIV-ref too.
  const listRoute = readFileSync("app/api/platform/customer-success/incidents/route.ts", "utf8");
  check("the CS list route computes each row's PRIV-ref server-side", /incidentListDTO\(result, "cs", now, fromClamped, \{ subjectRefOf: opaqueUserRef \}\)/.test(listRoute)
    && /import \{ opaqueUserRef \} from "@\/lib\/platform\/opaque-user-ref"/.test(listRoute));
  check("the Ops list route passes no ref function", !/opaqueUserRef|subjectRefOf/.test(readFileSync("app/api/platform/platform-ops/incidents/route.ts", "utf8")));
  check("the list renders the row's subjectRef, never r.subjectUserId as text", /\{`Customer \$\{r\.subjectRef \?\? OPAQUE_USER_REF_FALLBACK\}`\}/.test(lead) && !/customer \{r\.subjectUserId\}/.test(lead));

  const detailRoute = readFileSync("app/api/platform/customer-success/customers/[userId]/route.ts", "utf8");
  check("…which is CUSTOMER_SUCCESS READ and audits CUSTOMER_PROFILE_VIEWED", /requirePlatformAccess\("CUSTOMER_SUCCESS", "READ"\)/.test(detailRoute) && /AuditAction\.CUSTOMER_PROFILE_VIEWED/.test(detailRoute));
  const csRoute = readFileSync("app/api/platform/customer-success/incidents/[id]/route.ts", "utf8");
  check("the CS route computes the PRIV-ref server-side with opaqueUserRef", /import \{ opaqueUserRef \} from "@\/lib\/platform\/opaque-user-ref"/.test(csRoute) && /subjectRefOf: opaqueUserRef/.test(csRoute));
  const opsRoute = readFileSync("app/api/platform/platform-ops/incidents/[id]/route.ts", "utf8");
  check("the Ops route passes the component to the resolver and never a PRIV-ref", /component: inv\.component \?\? null/.test(opsRoute) && !/opaqueUserRef|subjectRefOf/.test(opsRoute));

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nincident-drawer-nav-job.test: all passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
