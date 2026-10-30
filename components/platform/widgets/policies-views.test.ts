/**
 * components/platform/widgets/policies-views.test.ts  (PLATFORM OPS PHASE 1 UX)
 *
 * Standalone tsx, exits 0/1.
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/policies-views.test.ts
 *
 * The Policies workspace renders ONE section (ops_policies) in several VIEWS
 * through OpsPoliciesWidget's `variant`. Pinned here:
 *
 *   1. NO variant renders exactly what the widget rendered before views: the
 *      full host's body is the pre-views widget body VERBATIM (source pin), and
 *      the surface still renders every part, in the same order, with the same
 *      gating (render).
 *   2. Each variant renders its slice and nothing else: "defaults" = refresh
 *      cadence + execution cadence + AI Cost Controls (incl. the kill switch);
 *      "emergency" = maintenance mode + the Plaid webhook repoint (CONTROL-tier
 *      access only, unchanged); "groups" = the read-only PolicyGroupsPanel.
 *   3. PolicyGroupsPanel is read-only and takes no access flag: no button, no
 *      input, no edit word; the capability ratchet's consumer set is unchanged.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { PoliciesSurface } from "./OpsPoliciesWidget";
import { POLICY_GROUPS_READ_ONLY_NOTE, PolicyGroupsPanel } from "./PolicyGroupsPanel";
import { OPERATIONAL_CONTROLS_TITLE } from "./maintenance-mode-view";
import { PLAID_WEBHOOK_PANEL_TITLE } from "./PlaidWebhookPanel";
import { AI_COST_CONTROLS_TITLE } from "./ai-cost-controls-view";
import type { PolicyGroupsResponse } from "@/app/api/platform/platform-ops/policy-groups/route";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`.slice(0, 600) : ""}`); }
}
const read = (p: string) => readFileSync(p, "utf8");
const strip = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const section = { id: "row-ops_policies", key: "ops_policies", label: "Policies" };
const LOADING = { data: null, loading: true, error: null } as const;
// Every read loading: each part renders its own frame + title, which is enough to tell the parts apart.
const surface = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(PoliciesSurface as never, {
  section, state: LOADING, cadence: LOADING, costControls: LOADING, operational: LOADING, canControl: true, ...over,
} as never));
/** The parts, in render order, identified by their titles. */
const parts = (html: string) => [
  ["policies", html.indexOf(">Policies<")],
  ["maintenance", html.indexOf(OPERATIONAL_CONTROLS_TITLE)],
  ["cost", html.indexOf(AI_COST_CONTROLS_TITLE)],
  ["webhook", html.indexOf(PLAID_WEBHOOK_PANEL_TITLE)],
].filter(([, i]) => (i as number) >= 0).sort((a, b) => (a[1] as number) - (b[1] as number)).map(([k]) => k).join(",");

console.log("1. no variant — the full surface, unchanged");
{
  const src = strip("components/platform/widgets/OpsPoliciesWidget.tsx");
  // The pre-views OpsPoliciesWidget body (develop 296516c), verbatim.
  const BEFORE_BODY = `  const state = useSharedWidgetFetch<PlatformPoliciesResponse>(POLICIES_URL);
  const publish = useSharedWidgetPublish<PlatformPoliciesResponse>(POLICIES_URL);
  const cadence = useSharedWidgetFetch<JobCadenceResponse>(JOB_CADENCE_URL);
  const publishCadence = useSharedWidgetPublish<JobCadenceResponse>(JOB_CADENCE_URL);
  const costControls = useSharedWidgetFetch<AiCostControlsReadModel>(COST_CONTROLS_URL);
  const publishCostControls = useSharedWidgetPublish<AiCostControlsReadModel>(COST_CONTROLS_URL);
  const operational = useSharedWidgetFetch<OperationalControlsReadModel>(OPERATIONAL_URL);
  const publishOperational = useSharedWidgetPublish<OperationalControlsReadModel>(OPERATIONAL_URL);
  return (
    <PoliciesSurface section={section} state={state} canControl={access?.canControl ?? false} onModel={publish}
      cadence={cadence} onCadenceModel={publishCadence} costControls={costControls} onCostControlsModel={publishCostControls}
      operational={operational} onOperationalModel={publishOperational} onOpenWorkspace={onOpenWorkspace} />
  );
}`;
  const full = src.slice(src.indexOf("function PoliciesFullHost("));
  check("the full host's body is the pre-views widget body, verbatim", full.includes(BEFORE_BODY));
  check("…and it is what the widget renders with NO variant",
    /return <PoliciesFullHost section=\{section\} access=\{access\} onOpenWorkspace=\{onOpenWorkspace\} \/>;\n\}/.test(src));
  check("every slice flag is true when no variant is given (they test the variant, never data)",
    /const showCadence = variant !== "emergency";/.test(src) && /const showCost = variant !== "emergency";/.test(src) && /const showEmergency = variant !== "defaults";/.test(src));

  const html = surface();
  check("renders all four parts, in the pre-views order", parts(html) === "policies,maintenance,cost,webhook", parts(html));
  check("the Plaid webhook panel still needs control-plane access", parts(surface({ canControl: false })) === "policies,maintenance,cost");
  check("an explicit undefined variant is the full surface too", surface({ variant: undefined }) === html);
}

console.log("2. each variant renders its slice");
{
  check("defaults = refresh + execution cadence + AI Cost Controls (with the kill switch inside it)", parts(surface({ variant: "defaults" })) === "policies,cost", parts(surface({ variant: "defaults" })));
  check("emergency = maintenance mode + the Plaid webhook repoint", parts(surface({ variant: "emergency" })) === "maintenance,webhook", parts(surface({ variant: "emergency" })));
  check("emergency for a non-control operator = maintenance mode only (its own read-only state)", parts(surface({ variant: "emergency", canControl: false })) === "maintenance");
  check("the defaults slice keeps the execution cadence panel inside the refresh surface",
    /\{cadence && <JobCadencePanel state=\{cadence\} canControl=\{canControl\}/.test(strip("components/platform/widgets/OpsPoliciesWidget.tsx")));
  const src = strip("components/platform/widgets/OpsPoliciesWidget.tsx");
  check("the widget routes each variant to its own host (each fetches only what it renders)",
    /if \(variant === "groups"\) return <PolicyGroupsHost \/>;/.test(src)
      && /if \(variant === "defaults"\) return <PoliciesDefaultsHost /.test(src)
      && /if \(variant === "emergency"\) return <PoliciesEmergencyHost /.test(src));
  const groupsHost = src.slice(src.indexOf("function PolicyGroupsHost("), src.indexOf("function PoliciesDefaultsHost("));
  check("the groups host reads ONLY the policy-groups route and passes no access flag",
    /useSharedWidgetFetch<PolicyGroupsResponse>\(POLICY_GROUPS_URL\)/.test(groupsHost) && !/access|canControl|Publish/.test(groupsHost)
      && /const POLICY_GROUPS_URL = "\/api\/platform\/platform-ops\/policy-groups";/.test(src));
  const emergencyHost = src.slice(src.indexOf("function PoliciesEmergencyHost("), src.indexOf("function PoliciesFullHost("));
  check("the emergency host reads only operational controls", /OPERATIONAL_URL/.test(emergencyHost) && !/POLICIES_URL\)|JOB_CADENCE_URL|COST_CONTROLS_URL/.test(emergencyHost));
}

console.log("3. PolicyGroupsPanel — read-only catalogue");
{
  const data: PolicyGroupsResponse = {
    dimensions: [
      { key: "conversations", label: "Conversations", description: "", kind: "boolean", ceiling: true },
      { key: "manualBankRefreshCooldownMinutes", label: "Bank refresh cooldown", description: "", kind: "minutes-floor", ceiling: 15 },
    ],
    policyGroups: [
      { key: "BETA", label: "Beta", description: "d", effectiveFrom: "2026-10-01", values: { conversations: true, manualBankRefreshCooldownMinutes: 30 }, customers: 7, isDefault: true },
      { key: "PLUS", label: "Plus", description: "d", effectiveFrom: "2026-10-01", values: { conversations: false, manualBankRefreshCooldownMinutes: 15 }, customers: 1, isDefault: false },
    ],
    overlays: [{ key: "SUPPORT_BOOST", label: "Support boost", description: "d", effectiveFrom: "2026-10-01", values: { manualBankRefreshCooldownMinutes: 15 }, customers: 2 }],
    cohorts: [{ key: "CLOSED_BETA", label: "Closed beta", description: "d", entry: "INVITE", customers: 9 }],
    unassignedCustomers: 3,
    unknownAssignments: 1,
    defaultPolicyGroup: "BETA",
    checkedAt: "2026-10-30T00:00:00.000Z",
  };
  const html = renderToStaticMarkup(createElement(PolicyGroupsPanel, { state: { data, loading: false, error: null } }));
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  check("counts: assigned (sum of groups), unassigned, unknown assignment", /8 Assigned/.test(text) && /3 On default \(unassigned\)/.test(text) && /1 Unknown assignment/.test(text), text.slice(0, 300));
  check("each group with its customers, the default marked (once per layout)", (html.match(/· default/g) ?? []).length === 2 && /7 customers/.test(text) && /1 customer\b/.test(text));
  check("each dimension: the group's value beside the platform ceiling, floors qualified", /Platform ceiling/.test(text) && /15 \(floor\)/.test(text) && /\bOn\b/.test(text) && /\bOff\b/.test(text));
  check("a compact table at md+, a card list below md", /class="hidden min-w-0 overflow-x-auto md:block"/.test(html) && /<table/.test(html) && /class="flex flex-col gap-3 md:hidden"/.test(html));
  check("overlays and cohorts with their customer counts", /Support boost/.test(text) && /Bank refresh cooldown: 15/.test(text) && /2 customers/.test(text) && /Closed beta/.test(text) && /9 customers/.test(text) && /entry invite/.test(text));
  check("ONE honest read-only line naming Phase 2", (html.match(/entitlement engine \(Phase 2\)/g) ?? []).length === 1 && POLICY_GROUPS_READ_ONLY_NOTE.includes("entitlement engine (Phase 2)"));
  check("no edit affordance of any kind: no button, input, select or form", !/<button|<input|<select|<form/.test(html));
  check("no customer identity in the fixture shape renders (counts only)", !/@|email/i.test(text));
  const loading = renderToStaticMarkup(createElement(PolicyGroupsPanel, { state: { data: null, loading: true, error: null } }));
  check("loading says so", /role="status"/.test(loading));
  const failed = renderToStaticMarkup(createElement(PolicyGroupsPanel, { state: { data: null, loading: false, error: "Not authorized" } }));
  check("a failed read is unavailable, never an empty catalogue", /role="alert"/.test(failed) && /could not be asked/.test(failed) && !/Assigned/.test(failed));

  const panelSrc = strip("components/platform/widgets/PolicyGroupsPanel.tsx");
  check("the panel takes no access flag and reads no control-plane access", !/canControl|canWrite|access/.test(panelSrc));
  check("the panel fetches nothing itself (prop-driven)", !/fetch\(|useWidgetFetch|useSharedWidgetFetch/.test(panelSrc));
}

if (failures > 0) { console.error(`\npolicies-views.test: ${failures} failure(s).`); process.exit(1); }
console.log("\npolicies-views.test: all passed.");
