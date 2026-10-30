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
 *   4. source rules;
 *   5. Beta reconciliation — the ONE entry: offered only behind the access
 *      flag and only while the dry run counts n > 0; the confirmation states
 *      the exact count and the guarantee and requires a reason; it reaches the
 *      real route (READ dry run, fresh CONTROL POST).
 *   6. POLICY EDITOR — edit affordances only when the editor offers actions
 *      (behind the access flag); the editor's edit step (categories, toggles,
 *      steppers + sliders vs the ceiling, floors, live effective + Founder),
 *      review step (before → after, customers affected, cost exposure labelled
 *      an estimated ceiling, measured spend "not yet available", reason), the
 *      default / archive steps, the version history (Restore only when offered),
 *      and the 390 px rules.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/leads/platform-visual-policies.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_POLICY_GROUP, DIMENSION_KEYS, ENTITLEMENT_CATEGORIES, ENTITLEMENT_DIMENSIONS, OVERLAYS, POLICY_GROUPS, COHORTS,
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
import { BetaReconciliationButton, BetaReconciliationConfirmBody, BetaReconciliationEntry, RECONCILE_URL } from "./BetaReconciliationEntry";
import { RECONCILE_GUARANTEE, reconcileConfirmCount, reconcileEntryLabel, reconcileOutcome } from "./policies-model";
import { EMPTY_OPERATOR_REASON } from "../widgets/OperatorReasonField";
import * as editorModule from "./PolicyGroupEditor";
import * as editorModel from "./policy-editor-model";
import * as historyModule from "./PolicyGroupHistory";

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
      // + the editor category (POLICY EDITOR), as readPolicyGroups now sends it.
      return { key, label: d.label, description: d.description, kind: d.kind, ceiling: d.ceiling, category: d.category, categoryLabel: ENTITLEMENT_CATEGORIES[d.category] };
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
  // POLICY EDITOR — the placeholder lines ("Arrives with the policy editor / policy economics") are gone:
  // the history + exposure block is hosted (PolicyGroupHistory via the `history` slot), and a reader
  // who may not edit is told once why there is no edit control.
  check("group detail: six categories + Assignments + effective-from line, no placeholder copy",
    (gd.match(/data-category=/g) ?? []).length === 6 && /Assignments/.test(gdt) && /Effective from 2026-10-08/.test(gdt) && !/Arrives with/.test(gdt));
  check("group detail (read-only): says why once, with no edit control", (gd.match(/data-read-only-note/g) ?? []).length === 1 && model.READ_ONLY_NOTE.length > 0 && !/<button/.test(gd));
  const withHistory = renderToStaticMarkup(createElement(PoliciesDrawerBody, { drawer: { kind: "group", key: "BETA_FULL_ACCESS_V1" }, data: DATA, renderHosted: () => null, onOpenWorkspace: () => {},
    history: (k: string) => createElement("div", { "data-history-slot": k }), editable: true }));
  check("group detail hosts the history + exposure block; an editor-enabled reader sees no read-only note",
    /data-history-slot="BETA_FULL_ACCESS_V1"/.test(withHistory) && !/data-read-only-note/.test(withHistory) && !/data-read-only/.test(withHistory));
  const overlayDetail = renderToStaticMarkup(createElement(PoliciesDrawerBody, { drawer: { kind: "group", key: "BETA_FULL_ACCESS_V1+FOUNDER_INTERNAL_V1" }, data: DATA, renderHosted: () => null, onOpenWorkspace: () => {},
    history: () => createElement("div", { "data-history-slot": "x" }) }));
  check("an overlay column has no history slot (overlays are code-owned)", !/data-history-slot/.test(overlayDetail));
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

// ── 5. Beta reconciliation ───────────────────────────────────────────────────

console.log("5. Beta reconciliation — one deliberate, gated entry");
{
  check("label: 'Assign Beta to n unassigned accounts' (singular / plural); none at 0 or unknown",
    reconcileEntryLabel(12) === "Assign Beta to 12 unassigned accounts" && reconcileEntryLabel(1) === "Assign Beta to 1 unassigned account"
      && reconcileEntryLabel(0) === null && reconcileEntryLabel(null) === null && reconcileEntryLabel(undefined) === null);
  check("eligible 0 ⇒ the button renders NOTHING (no disabled placeholder)", renderToStaticMarkup(createElement(BetaReconciliationButton, { eligible: 0, onSelect: () => {} })) === "");
  const btn = renderToStaticMarkup(createElement(BetaReconciliationButton, { eligible: 7, onSelect: () => {} }));
  check("eligible 7 ⇒ ONE dialog-opening button with the exact count", (btn.match(/<button/g) ?? []).length === 1 && /aria-haspopup="dialog"/.test(btn) && /Assign Beta to 7 unassigned accounts/.test(text(btn)) && !/disabled/.test(btn));
  const confirm = text(renderToStaticMarkup(createElement(BetaReconciliationConfirmBody, { eligible: 7, reason: EMPTY_OPERATOR_REASON, onReason: () => {}, disabled: false })));
  check("confirmation: the exact count", confirm.includes(reconcileConfirmCount(7)) && /7 active accounts without an assignment will be placed on Beta\./.test(confirm));
  check("confirmation: the guarantee, verbatim",
    RECONCILE_GUARANTEE === "Creates Beta assignments only for active accounts that have none. Existing assignments — including Founder — are never changed." && confirm.includes(RECONCILE_GUARANTEE));
  check("confirmation: a required reason (OperatorReasonField, nothing pre-selected)", /Choose a reason/.test(confirm) && /A reason is recorded with this action/.test(confirm));
  const src = code("components/platform/leads/BetaReconciliationEntry.tsx");
  check("confirm is disabled until a reason code is chosen; the confirmed count is echoed as expectedEligible",
    /confirmDisabled=\{reasonPayload\(reason\) === null\}/.test(src) && /JSON\.stringify\(\{ reason: why, expectedEligible \}\)/.test(src));
  check("on an answer it re-reads the catalogue, Attention and the dry run into the shared session",
    /read\(POLICY_GROUPS_URL, publishGroups\), read\(ATTENTION_URL, publishAttention\), read\(RECONCILE_URL, publishDryRun\)/.test(src));
  const access = (canControl: boolean) => ({ canRead: true, canWrite: true, canControl, level: canControl ? "X" : "WRITE" });
  check("without the access flag the entry renders nothing (and never reads the dry run)",
    renderToStaticMarkup(createElement(BetaReconciliationEntry, { access: access(false) as never })) === "" && renderToStaticMarkup(createElement(BetaReconciliationEntry, {})) === "");
  check("outcome words: created (+ skipped), 409 says re-check",
    reconcileOutcome(200, { created: 3, skipped: 1 }).text === "Assigned Beta to 3 accounts · 1 already assigned meanwhile (left unchanged)"
      && reconcileOutcome(409, { error: "The population changed — re-check." }).tone === "warn");

  const slotted = renderToStaticMarkup(createElement(PoliciesLeadSurface, props({ reconcileSlot: createElement(BetaReconciliationButton, { eligible: 4, onSelect: () => {} }) }) as never));
  check("the surface places the entry in the hero area, beside the Attention doorway",
    slotted.indexOf("data-beta-reconcile") > slotted.indexOf("data-health-hero") && slotted.indexOf("data-beta-reconcile") < slotted.indexOf("policies-distribution") && /data-attention-doorway/.test(slotted));
  check("…and it is the only action button on the default screen", buttons(slotted).filter((b) => /\b(Assign|Apply|Edit|Save)\b/.test(b)).length === 1);
  const lead = code("components/platform/leads/PoliciesLead.tsx");
  check("the lead mounts the entry with the operator's access (forwarded, never read)",
    /reconcileSlot=\{<BetaReconciliationEntry access=\{access\} \/>\}/.test(lead) && !/canControl/.test(lead));

  // Reachability — the entry's URL is the real route, READ for the dry run, fresh CONTROL for the write.
  const route = readFileSync(path.join(ROOT, "app/api/platform/platform-ops/policies/reconcile-beta/route.ts"), "utf8");
  check("reachable: the entry reads and posts the real route (GET READ, POST fresh)",
    RECONCILE_URL === "/api/platform/platform-ops/policies/reconcile-beta" && src.includes(`useSharedWidgetFetch<BetaReconciliationDryRunResponse>("${RECONCILE_URL}")`)
      && /export async function GET[\s\S]*requirePlatformAccess\("PLATFORM_OPS", "READ"\)/.test(route) && /export async function POST[\s\S]*requireFreshPlatformAccess\("PLATFORM_OPS",/.test(route));
}

// ── 6. Policy editor ─────────────────────────────────────────────────────────

console.log("6. Policy editor — gated affordances, edit → review → confirm, history");
{
  const noop = () => {};
  const actions = { onEdit: noop, onClone: noop, onNew: noop, onRestore: noop };
  const editable = renderToStaticMarkup(createElement(PoliciesLeadSurface, props({ edit: actions }) as never));
  check("with editor actions: each GROUP card offers Edit + Clone (the overlay column never does)",
    (editable.match(/data-group-edit="/g) ?? []).length === 1 && /data-group-edit="BETA_FULL_ACCESS_V1"/.test(editable)
      && /aria-label="Edit Beta — full access \(v1\)"/.test(editable) && /aria-label="Clone Beta — full access \(v1\)"/.test(editable));
  check("…'New group' on the Policy groups block", (editable.match(/data-new-group/g) ?? []).length === 1 && editable.indexOf("data-new-group") > editable.indexOf('id="policies-groups"'));
  check("…the group card drops its Read-only chip; the overlay card keeps it", (editable.match(/data-read-only/g) ?? []).length === 1);
  const readOnly = renderToStaticMarkup(createElement(PoliciesLeadSurface, props() as never));
  check("without actions: no Edit / Clone / New group anywhere (read-only operators)", !/data-group-edit|data-new-group/.test(readOnly) && !/\b(Edit|Clone|New group)\b/.test(buttons(readOnly).join(" ")));
  const lead = code("components/platform/leads/PoliciesLead.tsx");
  check("the lead takes its actions from usePolicyGroupEditor(access, …) and reads no access flag itself",
    /usePolicyGroupEditor\(access, groups\.data\)/.test(lead) && !/canControl/.test(lead) && /\{editor\.panel\}/.test(lead));

  // The gate, rendered: a tiny host calls the hook with each access shape.
  const Probe = ({ access }: { access: unknown }) => {
    const e = editorModule.usePolicyGroupEditor(access as never, DATA);
    return createElement("span", { "data-offered": e.actions ? "yes" : "no" });
  };
  const offered = (access: unknown) => /data-offered="yes"/.test(renderToStaticMarkup(createElement(Probe, { access })));
  check("usePolicyGroupEditor offers actions ONLY with canControl (not WRITE, not absent)",
    offered({ canRead: true, canWrite: true, canControl: true }) && !offered({ canRead: true, canWrite: true, canControl: false }) && !offered(undefined));

  // The editor body — edit step.
  const detail = {
    group: { key: "BETA_FULL_ACCESS_V1", label: "Beta — full access (v1)", description: "d", version: 2, builtIn: true, archived: false, archivedAt: null, isDefault: true, valid: true,
      invalidReasons: [], source: "DB", effectiveFrom: "2026-10-30", values: { ...POLICY_GROUPS.BETA_FULL_ACCESS_V1.values } },
    versions: [
      { version: 2, createdAt: "2026-10-30T10:00:00.000Z", createdBy: "opsadmin", label: "Beta — full access (v1)", reasonCode: "POLICY_ROLLOUT",
        summary: { kind: "UPDATED", changes: [{ key: "exportsPerDay", before: 2, after: 3 }] }, restorable: true, values: { ...POLICY_GROUPS.BETA_FULL_ACCESS_V1.values }, current: true },
      { version: 1, createdAt: "2026-10-29T10:00:00.000Z", createdBy: "Seeded from code", label: "Beta — full access (v1)", reasonCode: "POLICY_ROLLOUT",
        summary: { kind: "SEEDED", changes: [] }, restorable: true, values: { ...POLICY_GROUPS.BETA_FULL_ACCESS_V1.values, exportsPerDay: 2 }, current: false },
    ],
    versionsTruncated: false,
    assignments: { customers: 12, withOverlay: 2, withFounder: 2, unassignedResolvingHere: 0,
      buckets: [{ overlay: null, overrideUsd: null, count: 10 }, { overlay: "FOUNDER_INTERNAL_V1", overrideUsd: null, count: 2 }] },
    effective: { plain: null, founder: null },
    cost: { platformAllowanceUsd: null, current: null, measured30dUsd: null, measuredNote: "Measured AI spend per policy group is not yet available." },
    defaultPolicyGroup: "BETA_FULL_ACCESS_V1", failClosedEnforced: false, checkedAt: "2026-10-30T10:00:00.000Z",
  };
  const draft = { key: "BETA_FULL_ACCESS_V1", label: "Beta — full access (v1)", description: "d", values: { ...POLICY_GROUPS.BETA_FULL_ACCESS_V1.values } as Record<string, boolean | number> };
  const body = (over: Record<string, unknown>) => renderToStaticMarkup(createElement(editorModule.PolicyEditorBody, {
    mode: { kind: "edit", key: "BETA_FULL_ACCESS_V1" }, step: "edit", data: DATA, detail, draft, onDraft: noop, reason: EMPTY_OPERATOR_REASON, onReason: noop, busy: false, feedback: null, ...over,
  } as never));
  const edit = body({});
  const et = text(edit);
  check("edit: one section per catalogue category, in the editor order",
    [...edit.matchAll(/data-editor-section="([a-z]+)"/g)].map((m) => m[1]).join() === "ai,connections,refresh,exports,insights");
  check("edit: every dimension is a row exactly once", (edit.match(/data-editor-row=/g) ?? []).length === DIMENSION_KEYS.length);
  check("edit: on/off entitlements are real switches (role=switch, aria-checked)", (edit.match(/role="switch"/g) ?? []).length === 2 && /aria-checked="true"/.test(edit));
  check("edit: counts and floors are a stepper (− number +) and a slider", (edit.match(/type="number"/g) ?? []).length === 7 && (edit.match(/type="range"/g) ?? []).length === 7
    && /aria-label="Decrease Data exports per day"/.test(edit) && /aria-label="Increase Data exports per day"/.test(edit));
  check("edit: value vs the ceiling ('of 25', 'of $20') and the floor's fastest ('fastest 15 min')", /of 25/.test(et) && /of \$20/.test(et) && /fastest 15 min/.test(et));
  check("edit: a live EFFECTIVE value per row, and 'With Founder' because the group has Founder assignees",
    (edit.match(/data-effective/g) ?? []).length === DIMENSION_KEYS.length && /Effective \$5/.test(et) && /With Founder \$20/.test(et) && /With Founder 10/.test(et));
  const noFounder = text(body({ detail: { ...detail, assignments: { ...detail.assignments, withFounder: 0 } } }));
  check("edit: no Founder line when the group has no Founder assignees", !/With Founder/.test(noFounder));
  check("edit: the key field appears only for a NEW group (the key is immutable after create)",
    !/Key \(permanent\)/.test(et) && /Key \(permanent\)/.test(text(body({ mode: { kind: "new" }, draft: { ...draft, key: "" } }))));
  const bad = text(body({ draft: { ...draft, values: { ...draft.values, maxConnections: 99 } } }));
  check("edit: an out-of-range value is named under the form (the server's own rule)", /Maximum connections: must be between 0 and the platform ceiling of 25/.test(bad));

  // Review step.
  const changed = { ...draft, values: { ...draft.values, aiDailyUsdAllowance: 8, exportsPerDay: 4 } };
  const review = body({ step: "review", draft: changed });
  const rt = text(review);
  check("review: each changed entitlement before → after", /data-change="aiDailyUsdAllowance"/.test(review) && /\$5 → \$8/.test(rt) && /3 → 4/.test(rt) && (review.match(/data-change=/g) ?? []).length === 2);
  check("review: customers affected (counts)", /12 customers assigned · 2 with Founder/.test(rt));
  check("review: COST EXPOSURE = customers × allowance, labelled an estimated ceiling, was / now (10×$8 + 2×$20 = $120; was $90)",
    /\$120/.test(rt) && /was \$90/.test(rt) && /Estimated ceiling · max estimated AI spend \/ day/.test(rt));
  check("review: measured spend is said to be not yet available (never invented)", /Measured AI spend per policy group is not yet available\./.test(rt));
  check("review: a required structured reason", /Choose a reason/.test(rt) && /A reason is recorded with this action/.test(rt));
  const dflt = text(body({ step: "default" }));
  check("make default: says it affects NEW registrations only, with a reason", /Affects new registrations only — existing assignments do not change\./.test(dflt) && /Choose a reason/.test(dflt));
  const arch = text(body({ step: "archive" }));
  check("archive: says nothing is deleted, with a reason", /Nothing is deleted/.test(arch) && /Choose a reason/.test(arch));
  check("archive is blocked while customers are assigned, and for the default (said, not hidden)",
    /12 customers are assigned/.test(String(editorModel.archiveBlocker({ ...detail, group: { ...detail.group, isDefault: false, builtIn: false } } as never)))
      && /default group cannot be archived/.test(String(editorModel.archiveBlocker(detail as never))));

  check("review fix 6: a BUILT-IN group says it cannot be archived; the overflow renders no Archive item for it",
    /Built-in groups cannot be archived/.test(String(editorModel.archiveBlocker({ ...detail, group: { ...detail.group, isDefault: false }, assignments: { ...detail.assignments, customers: 0 } } as never)))
      && /\{!detail\?\.group\.builtIn && \(<>/.test(code("components/platform/leads/PolicyGroupEditor.tsx")));
  check("review fix 7: an archived card offers neither Edit nor Clone",
    !/<button/.test(renderToStaticMarkup(createElement(editorModule.GroupEditButtons, { groupKey: "OLD_V1", label: "Old", actions, archived: true }))));
  const blocked = renderToStaticMarkup(createElement(BetaReconciliationButton, { eligible: 3, onSelect: noop, blocked: "ARCHIVED" }));
  check("review fix 5: Beta archived ⇒ the entry says eligible-but-blocked, no button (never another group)",
    /data-beta-blocked/.test(blocked) && !/<button/.test(blocked) && /3 unassigned accounts · Beta is archived — not assigned/.test(text(blocked)));

  // History.
  const hist = renderToStaticMarkup(createElement(historyModule.PolicyGroupHistoryView, { detail: detail as never, loading: false, error: null }));
  const ht = text(hist);
  check("history: version, when, who, what changed; the current version marked", /v2/.test(ht) && /2026-10-30 10:00 UTC · opsadmin/.test(ht) && /Edited · 1 change/.test(ht) && /Seeded from the code catalogue/.test(ht) && /Current/.test(ht));
  check("history (read-only): NO Restore button", !/data-restore-version/.test(hist) && !/<button/.test(hist));
  const histEdit = renderToStaticMarkup(createElement(historyModule.PolicyGroupHistoryView, { detail: detail as never, loading: false, error: null, onRestore: noop }));
  check("history (offered): 'Restore this version' on earlier versions only", (histEdit.match(/data-restore-version=/g) ?? []).length === 1 && /data-restore-version="1"/.test(histEdit));
  check("history: cost exposure as an estimated ceiling ($90 = 10×$5 + 2×$20) and measured 'not yet available'",
    /\$90/.test(ht) && /Estimated ceiling · max estimated AI spend \/ day/.test(ht) && /not yet available/.test(ht));

  // 390 px rules (source): grids collapse below sm, every flex row can shrink, actions live in the sheet footer.
  const ed = code("components/platform/leads/PolicyGroupEditor.tsx");
  check("390 px: the row grid is single-column below sm; no fixed width wider than the phone",
    /grid min-w-0 gap-2 sm:grid-cols-\[minmax\(0,1fr\)_minmax\(0,9rem\)\]/.test(ed) && !/\bw-\[(\d{3,})px\]/.test(ed) && !/min-w-\[\d/.test(ed));
  check("390 px: the panel is the atlas RightPanel (a full-width bottom sheet on mobile) and its actions are in PanelFooter",
    /<RightPanel /.test(ed) && /<PanelFooter>[\s\S]*data-confirm[\s\S]*<\/PanelFooter>/.test(ed) && /<PanelFooter>[\s\S]*data-review[\s\S]*<\/PanelFooter>/.test(ed));
  check("touch targets: steppers, toggles and pills are ≥ 44 px below lg", /h-11 w-11/.test(ed) && /min-h-11/.test(ed) && /h-11 w-14/.test(ed));
  check("the editor files never spell the access level", ![ed, code("components/platform/leads/PolicyGroupHistory.tsx"), code("components/platform/leads/policy-editor-model.ts")].some((src) => /\bCONTROL\b/.test(src)));
  check("the history component reads no access flag (Restore arrives as a prop)", !/canControl|canWrite|access/.test(code("components/platform/leads/PolicyGroupHistory.tsx")));
  check("the editor writes only through the five policy-group routes",
    /\$\{groupDetailUrl\(draft\.key\)\}\/archive/.test(ed) && /\$\{groupDetailUrl\(draft\.key\)\}\/default/.test(ed) && /\$\{groupDetailUrl\(mode\.key\)\}\/rollback/.test(ed)
      && /send\(groupDetailUrl\(mode\.key\), "PATCH"/.test(ed) && /send\(CREATE_URL, "POST"/.test(ed) && editorModule.CREATE_URL === "/api/platform/platform-ops/policy-groups/create");
}

if (failures > 0) {
  console.error(`\nplatform-visual-policies: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nplatform-visual-policies: all checks passed.");
