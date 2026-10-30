/**
 * components/platform/leads/platform-visual-policies.test.ts  (Platform Ops visual spec §5 — Policies)
 *
 * The Policies dashboard, pinned:
 *   1. model — the six categories map the nine catalogue dimensions exactly
 *      once; the donut sums to the customers; meters are drawn against the
 *      platform ceiling (floors inverted); overlays are clamped; no edit
 *      affordance exists in the model;
 *   2. render — hero + KPIs, ≤ 5 items per default list, no paragraphs, the
 *      matrix (six categories, "No entitlements yet"), group cards, the three
 *      destination cards; no edit / save / disabled / switch control anywhere;
 *      nothing hosted mounts on the default screen;
 *   3. reachability — every policy, alert and emergency control the former
 *      views rendered is reachable: through a drawer (hosted with its variant)
 *      AND through the kept drill-down views, so old ?view= ids still resolve;
 *   4. source rules.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/leads/platform-visual-policies.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_POLICY_GROUP, DIMENSION_KEYS, ENTITLEMENT_DIMENSIONS, OVERLAYS, POLICY_GROUPS, COHORTS,
} from "@/lib/entitlements/catalogue";
import {
  PLATFORM_AREA_WORKSPACES, getPlatformWorkspaceComposition, platformAreaViewIds, resolvePlatformDestination, resolvePlatformViewId, viewSectionKey,
} from "@/lib/platform/workspaces";
import type { PolicyGroupsResponse } from "@/app/api/platform/platform-ops/policy-groups/route";
import * as model from "./policies-model";
import {
  POLICY_CATEGORIES, NO_ENTITLEMENTS_YET, cellModel, clampToCeiling, comparisonMatrix, coverage, distribution, groupDetail, keyLimits,
  policyColumns, policyKpis, shortName, uncategorised,
} from "./policies-model";
import { POLICY_DRAWERS, PoliciesDrawerBody, PoliciesLeadSurface, policiesDrawerTitle } from "./PoliciesLead";
import { PlatformWorkspaceBody } from "../PlatformSpaceDashboard";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const ok = <T,>(data: T) => ({ data, loading: false, error: null });
const failed = (error: string) => ({ data: null, loading: false, error });
function lists(html: string): { label: string; items: number }[] {
  const out: { label: string; items: number }[] = [];
  for (const m of html.matchAll(/<ul aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/ul>/g)) out.push({ label: m[1], items: (m[2].match(/<li[ >]/g) ?? []).length });
  return out;
}
const paragraphs = (html: string) => (html.match(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g) ?? []).map(text);
const buttons = (html: string) => (html.match(/<button[\s\S]*?<\/button>/g) ?? []).map(text);

// ── Fixture: the REAL catalogue (as readPolicyGroups builds it) with counts ────

function catalogue(counts: { groups?: Record<string, number>; overlays?: Record<string, number>; unassigned?: number; unknown?: number } = {}): PolicyGroupsResponse {
  return {
    dimensions: DIMENSION_KEYS.map((key) => {
      const d = ENTITLEMENT_DIMENSIONS[key];
      return { key, label: d.label, description: d.description, kind: d.kind, ceiling: d.ceiling };
    }),
    policyGroups: Object.values(POLICY_GROUPS).map((g) => ({
      key: g.key, label: g.label, description: g.description, effectiveFrom: g.effectiveFrom,
      values: g.values as Record<string, boolean | number>, customers: counts.groups?.[g.key] ?? 0, isDefault: g.key === DEFAULT_POLICY_GROUP,
    })),
    overlays: Object.values(OVERLAYS).map((o) => ({
      key: o.key, label: o.label, description: o.description, effectiveFrom: o.effectiveFrom,
      values: o.values as Record<string, boolean | number>, customers: counts.overlays?.[o.key] ?? 0,
    })),
    cohorts: Object.values(COHORTS).map((c) => ({ key: c.key, label: c.label, description: c.description, entry: c.entry, customers: 0 })),
    unassignedCustomers: counts.unassigned ?? 0,
    unknownAssignments: counts.unknown ?? 0,
    defaultPolicyGroup: DEFAULT_POLICY_GROUP,
    checkedAt: "2026-10-30T09:41:00.000Z",
  };
}
const DATA = catalogue({ groups: { BETA_FULL_ACCESS_V1: 37 }, overlays: { FOUNDER_INTERNAL_V1: 2 }, unassigned: 3, unknown: 1 });
const CLEAN = catalogue({ groups: { BETA_FULL_ACCESS_V1: 12 } });
const dim = (k: string) => DATA.dimensions.find((d) => d.key === k)!;

// ── 1. Model ─────────────────────────────────────────────────────────────────

console.log("1. Model — categories, coverage, donut, meters vs ceilings");
{
  const mapped = POLICY_CATEGORIES.flatMap((c) => c.dimensions);
  check("six categories, in the owner's order",
    POLICY_CATEGORIES.map((c) => c.label).join(" · ") === "Connections & accounts · Refresh & synchronization · Crypto history & data coverage · AI features & allowances · Financial insights & reports · Exports & premium features");
  check(`the categories map all ${DIMENSION_KEYS.length} catalogue dimensions exactly once`,
    mapped.length === DIMENSION_KEYS.length && new Set(mapped).size === mapped.length && DIMENSION_KEYS.every((k) => mapped.includes(k)) && uncategorised(DATA).length === 0,
    `${mapped.length} mapped; missing ${DIMENSION_KEYS.filter((k) => !mapped.includes(k)).join()}`);
  check("every dimension has a plain-English label", DIMENSION_KEYS.every((k) => typeof model.PLAIN_LABEL[k] === "string" && model.PLAIN_LABEL[k].length > 0));
  const matrix = comparisonMatrix(DATA);
  check("a category with no dimension says 'No entitlements yet' (crypto) — never an invented row",
    matrix.find((c) => c.id === "crypto")!.rows.length === 0 && NO_ENTITLEMENTS_YET === "No entitlements yet");
  check("the matrix rows are the nine dimensions, once each", matrix.flatMap((c) => c.rows.map((r) => r.key)).sort().join() === [...DIMENSION_KEYS].sort().join());

  const cov = coverage(DATA);
  check("coverage: covered 37 of 41 (37 + 3 unassigned + 1 unknown), 2 on an overlay", cov.covered === 37 && cov.total === 41 && cov.overlaysInUse === 2);
  const slices = distribution(DATA);
  check("donut: Beta · Unassigned · Unknown group, and the slices sum to the total",
    slices.map((s) => `${s.label}=${s.value}`).join() === "Beta=37,Unassigned=3,Unknown group=1" && slices.reduce((a, s) => a + s.value, 0) === cov.total);
  check("donut: zero slices are dropped (a clean fleet is one slice)", distribution(CLEAN).map((s) => s.id).join() === "BETA_FULL_ACCESS_V1");

  const cols = policyColumns(DATA);
  check("columns: the group, then the overlay as effective 'Beta + Founder'",
    cols.map((c) => `${c.label}/${c.kind}`).join() === "Beta/group,Beta + Founder/overlay" && shortName("Founder / internal (v1)") === "Founder");
  const eff = cols[1].values;
  check("overlay effective = overlay over the default group, clamped to the ceiling (turns/min 30, allowance $20, connections 25, cooldown 15)",
    eff.aiTurnsPerMinute === 30 && eff.aiDailyUsdAllowance === 20 && eff.maxConnections === 25 && eff.manualBankRefreshCooldownMinutes === 15 && eff.aiTurnsPerHour === 60 && eff.conversations === true);
  check("clamp: a count above its ceiling is cut; a floor below its ceiling is raised; a boolean is AND-ed with the ceiling",
    clampToCeiling(dim("maxConnections"), 99) === 25 && clampToCeiling(dim("manualBankRefreshCooldownMinutes"), 5) === 15 && clampToCeiling({ ...dim("conversations"), ceiling: false }, true) === false);

  const c10 = cellModel(dim("maxConnections"), 10);
  check("meter: 10 of 25 connections = 40 %", c10.kind === "meter" && c10.pct === 40 && c10.text === "10" && c10.ceilingText === "of 25" && !c10.atCeiling);
  const usd = cellModel(dim("aiDailyUsdAllowance"), 5);
  check("meter: the AI allowance reads in dollars ($5 of $20 = 25 %)", usd.kind === "meter" && usd.text === "$5" && usd.ceilingText === "of $20" && usd.pct === 25);
  const floor = cellModel(dim("manualBankRefreshCooldownMinutes"), 60);
  check("meter: a floor is drawn inverted (every 1 h vs fastest 15 min = 25 %)", floor.kind === "meter" && floor.pct === 25 && floor.text === "every 1 h" && floor.ceilingText === "fastest 15 min");
  const at = cellModel(dim("aiTurnsPerHour"), 60);
  check("meter: at the ceiling = 100 % and flagged", at.kind === "meter" && at.pct === 100 && at.atCeiling);
  const tog = cellModel(dim("conversations"), true);
  check("boolean: a toggle shape (On), never a meter", tog.kind === "toggle" && tog.on && tog.text === "On");
  check("missing value: '—', never 0", cellModel(dim("exportsPerDay"), undefined).text === "—");

  check("group card key limits: connections · AI allowance · exports", keyLimits(DATA, cols[0]).map((l) => l.key).join() === "maxConnections,aiDailyUsdAllowance,exportsPerDay");
  const kp = policyKpis(ok(DATA));
  check("KPIs: groups 1 · unassigned 3 (warn, fail-closed exposure) · unknown 1 (bad) · overlays in use 2",
    kp.map((k) => `${k.key}=${k.value}`).join() === "groups=1,unassigned=3,unknown=1,overlays=2" && kp[1].tone === "warn" && /fail-closed exposure/.test(kp[1].sub) && kp[2].tone === "bad");
  check("KPIs unread ⇒ '—' everywhere, never 0", policyKpis(failed("x") as never).every((k) => k.value === "—"));

  const gd = groupDetail(DATA, "BETA_FULL_ACCESS_V1")!;
  check("group detail: six categories, assignments ≤ 4 (counts only)", gd.categories.length === 6 && gd.assignments.length <= 4 && gd.assignments.every((a) => /^\d[\d,]*$/.test(a.value)));
  check("group detail: an unknown key is no detail", groupDetail(DATA, "NOPE") === null);

  // No edit affordance in the model: nothing it exports edits, saves or drafts.
  const exported = Object.keys(model);
  check("model exports no edit / save / draft / mutation function", exported.filter((k) => typeof (model as Record<string, unknown>)[k] === "function").every((k) => !/^(edit|save|update|set|draft|apply|mutate|patch)/i.test(k)) && !/PATCH|DELETE|method:/.test(code("components/platform/leads/policies-model.ts")));
}

// ── 2. Render ────────────────────────────────────────────────────────────────

console.log("2. Render — the default screen");
const opsP = ok({ checkedAt: "x", grace: { floorHours: 1, share: 0.5 }, policies: [
  { sourceKind: "BANK", label: "Bank refresh", effective: { expectedEveryHours: 24, origin: "DEFAULT" } },
  { sourceKind: "WALLET", label: "Wallet refresh", effective: { expectedEveryHours: 6, origin: "SETTING" } },
] });
const cadence = ok({ checkedAt: "x", wakeEveryMinutes: 15, jobs: [
  { job: "a", editable: true, origin: "SETTING" }, { job: "b", editable: true, origin: "DEFAULT" }, { job: "c", editable: false, origin: "FIXED" },
] });
const cost = (paused = false) => ok({ allowance: { enforced: { value: true }, effectiveDefaultUsd: 5, overrides: { count: 1, customers: [] } }, killSwitch: { paused: { value: paused, origin: paused ? "SETTING" : "DEFAULT" } } });
const operational = (state = "MISSING") => ok({ maintenance: { state }, related: {} });
const alerts = ok({ destinationConfigured: true, lastEvaluatedAt: null, rules: [{ live: true, enabled: true }, { live: true, enabled: false }, { live: false, enabled: false }], history: [], historyRuns: 0,
  latest: { evaluatedAtISO: "x", deliveryStatus: "none", undelivered: null, counts: {}, rules: [] } });
const props = (over: Record<string, unknown> = {}) => ({
  groups: ok(DATA), policies: opsP, cadence, costControls: cost(), operational: operational(), alerts,
  hasHosted: () => true, onOpenDrawer: () => {}, onOpenWorkspace: () => {}, ...over,
});
{
  const html = renderToStaticMarkup(createElement(PoliciesLeadSurface, props() as never));
  const t = text(html);
  check("hero 'Customer policies' = 37 of 41, checked time, default group caption", /Customer policies/.test(t) && /37 of 41/.test(t) && /Checked 09:41 UTC/.test(t) && /default group: Beta — full access \(v1\)/.test(t));
  check("hero KPIs: Policy groups · Unassigned · Unknown group · Overlays in use", /Policy groups/.test(t) && /Unassigned/.test(t) && /Unknown group/.test(t) && /Overlays in use/.test(t));
  check("exposure ⇒ ONE Attention doorway (4 customers)", /data-attention-doorway/.test(html) && /4 customers without a valid assignment · Attention/.test(t));
  check("a clean fleet shows no Attention doorway", !/data-attention-doorway/.test(renderToStaticMarkup(createElement(PoliciesLeadSurface, props({ groups: ok(CLEAN) }) as never))));
  check("donut (BreakdownWidget) centred on the customer total", /data-center-total="true">41<\/p><p[^>]*>customers<\/p>/.test(html));
  const cats = (html.match(/data-category="([a-z]+)"/g) ?? []).length;
  check("matrix: six category groups; crypto says 'No entitlements yet'; desktop-only", cats === 6 && /No entitlements yet/.test(t) && /id="policies-matrix" class="[^"]*max-lg:hidden/.test(html));
  check("matrix: Beta and 'Beta + Founder' columns, meters + toggle shapes (read-only pictures)", /Beta \+ Founder/.test(t) && /role="meter"/.test(html) && /data-toggle-shape="on"/.test(html));
  check("group cards: 2 (group + overlay as applied), 1 col < lg, 2 col ≥ lg, each 'Read-only' with 3 key limits",
    (html.match(/data-group-card=/g) ?? []).length === 2 && /aria-label="Policy groups" class="[^"]*lg:grid-cols-2/.test(html)
      && (html.match(/data-read-only/g) ?? []).length === 2
      && [...html.matchAll(/aria-label="[^"]+ key limits"[^>]*>([\s\S]*?)<\/ul>/g)].map((m) => (m[1].match(/<li[ >]/g) ?? []).length).join() === "3,3");
  check("defaults card: refresh · job · AI allowance summary lines",
    /Bank every 24 h · Wallet every 6 h \(override\)/.test(t) && /3 jobs · 2 editable · 1 override/.test(t) && /\$5\/day default · enforced · 1 override/.test(t));
  check("alerts card: rules count + last delivery", /3 rules · 1 enabled/.test(t) && /Nothing to send/.test(t));
  check("emergency card: danger zone with maintenance, kill switch, Plaid webhook", /data-danger-zone/.test(html) && /Off \(not configured\)/.test(t) && /Running/.test(t) && /Plaid webhook/.test(t));
  const loud = text(renderToStaticMarkup(createElement(PoliciesLeadSurface, props({ operational: operational("ON"), costControls: cost(true) }) as never)));
  check("emergency engaged: maintenance On and AI Paused are said in words", /On — customers blocked/.test(loud) && /Paused/.test(loud));
  check("every default list ≤ 5", lists(html).every((l) => l.items <= 5), JSON.stringify(lists(html)));
  check("no paragraph on the default screen (every text line ≤ 90 chars)", paragraphs(html).every((p) => p.length <= 90), paragraphs(html).filter((p) => p.length > 90).join(" | "));
  check("no edit affordance: no Edit / Save / Change / Assign button, nothing disabled, no switch or input",
    buttons(html).every((b) => !/\b(Edit|Save|Change|Assign|Apply|Reset)\b/.test(b)) && !/disabled|role="switch"|<input|<select/.test(html));
  check("the editing line is NOT on the default screen (said once, in the group detail)", !/Editing arrives/.test(t));
  check("DOM order = mobile order: hero → donut → matrix → groups → defaults · alerts · emergency",
    ["data-health-hero", "policies-distribution", "policies-matrix", "policies-groups", "policies-defaults", "policies-alerts", "policies-emergency"].map((k) => html.indexOf(k)).every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1])));
  const unread = text(renderToStaticMarkup(createElement(PoliciesLeadSurface, props({ groups: failed("HTTP 500") }) as never)));
  check("a failed catalogue read: hero Unknown, no figure invented", /Customer policies Unknown/.test(unread) && /Policy catalogue unavailable — HTTP 500/.test(unread) && !/\d+ of \d+/.test(unread));
  const noHost = renderToStaticMarkup(createElement(PoliciesLeadSurface, props({ hasHosted: () => false }) as never));
  check("without hosted rows the destination lines are plain text (no dead doorway)", !/aria-haspopup="dialog"[^>]*>[^<]*<span[^>]*>Refresh cadence/.test(noHost) && !/>Catalogue</.test(noHost));

  // Group detail drawer.
  const gd = renderToStaticMarkup(createElement(PoliciesDrawerBody, { drawer: { kind: "group", key: "BETA_FULL_ACCESS_V1" }, data: DATA, renderHosted: () => null, onOpenWorkspace: () => {} }));
  const gdt = text(gd);
  check("group detail: six categories + Assignments + Version history + Cost exposure",
    (gd.match(/data-category=/g) ?? []).length === 6 && /Assignments/.test(gdt) && /Effective from 2026-10-08 · Arrives with the policy editor/.test(gdt) && /Arrives with policy economics/.test(gdt));
  check("group detail: says 'Editing arrives with the policy editor' exactly once, with no edit control", (gdt.match(/Editing arrives with the policy editor/g) ?? []).length === 1 && !/<button/.test(gd));
  check("drawer titles: a group by its catalogue name; a ghost group stays closed",
    policiesDrawerTitle({ kind: "group", key: "BETA_FULL_ACCESS_V1" }, DATA) === "Beta — full access (v1)" && policiesDrawerTitle({ kind: "group", key: "X" }, DATA) === "");
}

// ── 3. Reachability ──────────────────────────────────────────────────────────

console.log("3. Reachability — every policy / alert / emergency control");
{
  const comp = getPlatformWorkspaceComposition("PLATFORM_OPS", "platform-policies")!;
  const groupsView = comp.views![0];
  check("the default view is the policies lead hosting ops_policies + ops_alerts", groupsView.id === "groups" && groupsView.lead === "policies" && (groupsView.hosted ?? []).join() === "ops_policies,ops_alerts");

  const hosted = (drawer: never) => { const got: string[] = []; renderToStaticMarkup(createElement(PoliciesDrawerBody, { drawer, data: DATA, renderHosted: (k: string, _o?: unknown, v?: string) => { got.push(`${k}/${v ?? "-"}`); return null; }, onOpenWorkspace: () => {} })); return got.join(); };
  check("Platform defaults drawer → ops_policies · defaults (refresh + execution cadence, AI cost controls incl. the kill switch)", hosted({ kind: "defaults" } as never) === "ops_policies/defaults");
  check("Emergency drawer → ops_policies · emergency (maintenance mode, Plaid webhook)", hosted({ kind: "emergency" } as never) === "ops_policies/emergency");
  check("Alerts drawer → ops_alerts (bare)", hosted({ kind: "alerts" } as never) === "ops_alerts/-");
  check("Catalogue drawer → ops_policies · groups (overlays, cohorts)", hosted({ kind: "catalogue" } as never) === "ops_policies/groups");
  const drawerKeys = new Set<string>(Object.values(POLICY_DRAWERS).map((d) => d.key));
  check("every hosted key of the groups view is opened by a drawer", (groupsView.hosted ?? []).every((k) => drawerKeys.has(k)));
  check("every ops_policies variant is reachable from a drawer", ["groups", "defaults", "emergency"].every((v) => Object.values(POLICY_DRAWERS).some((d) => d.key === "ops_policies" && d.variant === v)));

  // The dashboard's cards open those drawers.
  const opened: string[] = [];
  const html = renderToStaticMarkup(createElement(PoliciesLeadSurface, props({ onOpenDrawer: (d: { kind: string }) => opened.push(d.kind) }) as never));
  check("the cards render a doorway to defaults, alerts, emergency and the catalogue",
    /Refresh cadence/.test(html) && /Last delivery/.test(html) && /Maintenance mode/.test(html) && /AI kill switch/.test(html) && />Catalogue/.test(html));

  // Old ?view= ids and read-model targets still resolve to their drill-down content.
  const ids = platformAreaViewIds("PLATFORM_OPS")["platform-policies"];
  check("old view ids resolve: groups · defaults · alerts · emergency", ["groups", "defaults", "alerts", "emergency"].every((v) => resolvePlatformViewId(ids, v) === v));
  check("read-model targets platform-policies:defaults / :alerts resolve", resolvePlatformDestination("platform-policies:defaults")?.viewId === "defaults" && resolvePlatformDestination("platform-policies:alerts")?.viewId === "alerts");
  const inline = comp.views!.slice(1).map((v) => `${v.id}:${v.sections.map((e) => typeof e === "string" ? e : `${viewSectionKey(e)}/${e.variant}`).join("+")}`).join(" ");
  check("drill-downs keep their inline controls unchanged", inline === "defaults:ops_policies/defaults alerts:ops_alerts emergency:ops_policies/emergency", inline);

  // The real workspace body renders the lead and nothing hosted inline.
  const row = (key: string) => ({ id: `row-${key}`, key, label: `DB::${key}` });
  const dbByKey = new Map(["ops_policies", "ops_alerts"].map((k) => [k, row(k)] as const));
  const body = renderToStaticMarkup(createElement(PlatformWorkspaceBody, { sectionKeys: groupsView.sections, dbByKey: dbByKey as never, onOpen: () => {}, lead: groupsView.lead, hosted: groupsView.hosted }));
  check("the workspace body renders the Policies dashboard with no inline section", /data-policies-dashboard/.test(body) && !/id="platform-section-/.test(body));
  check("Policies is the 4th Operations workspace", PLATFORM_AREA_WORKSPACES.PLATFORM_OPS[3].workspaceId === "platform-policies");
}

// ── 4. Source rules ──────────────────────────────────────────────────────────

console.log("4. Source rules");
for (const f of ["components/platform/leads/PoliciesLead.tsx", "components/platform/leads/policies-model.ts"]) {
  const src = code(f);
  check(`${f}: no access-level literal / control flag`, !/\bCONTROL\b/.test(src) && !/canControl|canWrite/.test(src));
  check(`${f}: no viewport read, no raw fetch`, !/matchMedia|innerWidth/.test(src) && !/\bfetch\(/.test(src));
  check(`${f}: never imports a hosted widget or panel (hosted, never re-wrapped)`, !/OpsPoliciesWidget|OpsAlertsWidget|MaintenanceModePanel|AiCostControlsPanel|PlaidWebhookPanel|PolicyGroupsPanel/.test(src.replace(/^\s*\*.*$/gm, "")));
  check(`${f}: imports no entitlement logic (catalogue metadata arrives through the read route)`, !/@\/lib\/entitlements\//.test(src));
}
check("Personal components are imported, not forked (BreakdownWidget; CompactKpiStrip via HealthHero)",
  /from "@\/components\/space\/widgets\/BreakdownWidget"/.test(code("components/platform/leads/PoliciesLead.tsx")) && /HealthHero/.test(code("components/platform/leads/PoliciesLead.tsx")));
check("reads only existing PLATFORM_OPS READ routes", (code("components/platform/leads/PoliciesLead.tsx").match(/useSharedWidgetFetch<[^>]+>\("([^"]+)"\)/g) ?? []).length === 6
  && ["policy-groups", "policies", "job-cadence", "ai-cost-controls", "operational-controls", "alerts"].every((r) => readFileSync(path.join(ROOT, `app/api/platform/platform-ops/${r}/route.ts`), "utf8").includes(`requirePlatformAccess("PLATFORM_OPS", "READ")`)));

if (failures > 0) {
  console.error(`\nplatform-visual-policies: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nplatform-visual-policies: all checks passed.");
