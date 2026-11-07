/**
 * lib/platform/customer/population.test.ts  (Platform Intelligence — "active" vocabulary pins)
 *
 * Proves:
 *   1. VALUES — the shared predicates are exactly today's: Open account =
 *      deactivatedAt IS NULL; Customer = role USER; the replaced reads keep
 *      their exact `where` (populations unchanged).
 *   2. UNDECIDED — the four owner decisions (OD-1..OD-4) are named policies,
 *      every one UNDECIDED, and the injected defaults change nothing; the
 *      pending note names them.
 *   3. CENSUS — no Platform reader (lib/platform, app/api/platform) restates
 *      the open-account predicate inline; the named exceptions are not reads.
 *   4. The X9 window consolidation: ENGAGEMENT_WINDOW_DAYS is the only window
 *      source; each remaining rolling read carries the X5 note.
 *   5. COPY — the renamed labels render and the old ones are gone.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/customer/population.test.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  CLOSED_ACCOUNT_WHERE, CUSTOMER_POPULATION_POLICY, CUSTOMER_WHERE, DEACTIVATED_IN_WINDOW_POLICY, ECONOMICS_WINDOW_POLICY,
  OPEN_ACCOUNT_WHERE, OPEN_CUSTOMER_WHERE, OPERATOR_EXCLUSION_POLICY, POPULATION_DECISIONS, TEST_ACCOUNT_POLICY,
  customerWhere, economicsEngagementStart, engagedPopulation, openCustomerWhere, pendingDefinitionNote,
} from "./population";
import { UNASSIGNED_CUSTOMER_WHERE } from "@/lib/platform/policy-assignment-health";
import { ELIGIBLE_WHERE } from "@/lib/platform/policies/reconcile-beta";
import { ENGAGEMENT_WINDOW_DAYS } from "@/lib/presence/definitions";
import { PRODUCT_ANALYTICS_WINDOW_DAYS } from "@/lib/platform/growth/product-analytics-core";
import { CS_POPULATION_PENDING_NOTE } from "@/components/platform/leads/customer-success-model";
import { ECONOMICS_PENDING_NOTE } from "@/lib/platform/economics/snapshot-core";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, detail ?? ""); }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ROOT = process.cwd();
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
/** Comments stripped, so prose never satisfies (or trips) a pin. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

console.log("\n1. values — populations unchanged");
check("Open account = deactivatedAt IS NULL (pending deletion also stamps deactivatedAt)", same(OPEN_ACCOUNT_WHERE, { deactivatedAt: null }));
check("Closed account = deactivatedAt IS NOT NULL", same(CLOSED_ACCOUNT_WHERE, { deactivatedAt: { not: null } }));
check("Customer = role USER exactly", same(CUSTOMER_WHERE, { role: "USER" }) && same(customerWhere(), { role: "USER" }));
check("Customer ∧ Open account = role USER ∧ deactivatedAt IS NULL", same(OPEN_CUSTOMER_WHERE, { role: "USER", deactivatedAt: null }) && same(openCustomerWhere(), OPEN_CUSTOMER_WHERE));
check("the unassigned-customer predicate is unchanged (alert + CS + policies)", same(UNASSIGNED_CUSTOMER_WHERE, { role: "USER", deactivatedAt: null, policyAssignment: { is: null } }));
check("the beta reconcile eligibility is unchanged", same(ELIGIBLE_WHERE, { role: "USER", deactivatedAt: null, policyAssignment: { is: null } }));

console.log("\n2. owner decisions — named, injected, UNDECIDED");
check("four decisions, OD-1..OD-4, each named once", same(POPULATION_DECISIONS.map((p) => p.decision), ["OD-1", "OD-2", "OD-3", "OD-4"]));
check("every decision is UNDECIDED", POPULATION_DECISIONS.every((p) => p.status === "UNDECIDED"));
check("every decision states its question and its interim (today's) behaviour",
  POPULATION_DECISIONS.every((p) => p.question.trim().length > 0 && /as today/.test(p.interim) && p.subject.trim().length > 0));
check("the Customer policy is OD-2 + OD-4", CUSTOMER_POPULATION_POLICY.operators === OPERATOR_EXCLUSION_POLICY && CUSTOMER_POPULATION_POLICY.testAccounts === TEST_ACCOUNT_POLICY);
{
  const start = new Date("2026-11-01T00:00:00Z");
  check("OD-1 default keeps the cycle start", economicsEngagementStart(start).getTime() === start.getTime()
    && economicsEngagementStart(start, ECONOMICS_WINDOW_POLICY).getTime() === start.getTime());
  const set = new Set(["a", "b"]);
  check("OD-3 default keeps every engaged user", engagedPopulation(set) === set && engagedPopulation(set, DEACTIVATED_IN_WINDOW_POLICY).size === 2);
}
check("the pending note names the decisions and says nothing changed",
  pendingDefinitionNote(OPERATOR_EXCLUSION_POLICY, TEST_ACCOUNT_POLICY) === "Pending the owner's definition (OD-2, OD-4): whether operators count as customers; whether test and internal accounts are excluded. Counted as today until decided.");
check("CS surfaces the OD-2 / OD-4 note", CS_POPULATION_PENDING_NOTE.includes("(OD-2, OD-4)"));
check("Economics surfaces OD-1..OD-4 in the figure basis", ECONOMICS_PENDING_NOTE.includes("(OD-1, OD-2, OD-3, OD-4)"));
{
  const lead = code(read("components/platform/leads/CustomerSuccessLead.tsx"));
  check("CS renders the pending note beside the customer counts", /<Caption>\{CS_POPULATION_PENDING_NOTE\}<\/Caption>/.test(lead));
  const snap = code(read("lib/platform/economics/snapshot-core.ts"));
  check("both economics customer figures carry the pending note in their basis (tooltip + drill)",
    (snap.match(/\$\{ECONOMICS_PENDING_NOTE\}/g) ?? []).length === 2);
  const reader = code(read("lib/platform/economics/snapshot.ts"));
  check("the economics reader opens its engagement window through the OD-1 policy", /economicsEngagementStart\(cycleStart, deps\.windowPolicy\)/.test(reader));
  const pa = code(read("lib/platform/growth/product-analytics.ts"));
  check("the engaged-set loader returns through the OD-3 policy", /return engagedPopulation\(out, policy\);/.test(pa));
}
{
  // A ruling cannot be adopted silently: a DECIDED policy does not typecheck where an UNDECIDED one is injected.
  const decided = { ...OPERATOR_EXCLUSION_POLICY, status: "DECIDED" as const };
  // @ts-expect-error — a decided policy must be handled in population.ts before any reader accepts it
  customerWhere({ operators: decided, testAccounts: TEST_ACCOUNT_POLICY });
  check("tsc refuses a non-UNDECIDED policy (the @ts-expect-error above is load-bearing under `tsc --noEmit`)", true);
}

console.log("\n3. census — no inline open-account predicate in a Platform reader");
{
  const walk = (dir: string): string[] => readdirSync(path.join(ROOT, dir)).flatMap((n) => {
    const rel = path.posix.join(dir, n);
    return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [rel] : [];
  });
  /** Named exceptions — none is a population read. */
  const EXCEPTIONS: Record<string, string> = {
    "lib/platform/customer/population.ts": "THE definition",
    "lib/platform/customer/customer-core.ts": "an in-memory funnel fact for one customer (a stage row), not a where",
    "app/api/platform/customer-success/customers/[userId]/access/route.ts": "the reactivation WRITE (data) and its audit envelope",
  };
  const files = [...walk("lib/platform"), ...walk("app/api/platform")];
  const INLINE = /deactivatedAt:\s*(null|\{\s*not:\s*null\s*\})/;
  const offenders = files.filter((f) => !(f in EXCEPTIONS) && INLINE.test(code(read(f))));
  check(`no inline deactivatedAt predicate outside population.ts (${files.length} files scanned)`, offenders.length === 0, offenders);
  const stale = Object.keys(EXCEPTIONS).filter((f) => f !== "lib/platform/customer/population.ts" && !INLINE.test(code(read(f))));
  check("every named exception still needs its exemption (no stale allowlist)", stale.length === 0, stale);
  const ROLE_INLINE = /role:\s*(?:"USER"(?:\s+as\s+const)?|UserRole\.USER)\s*[,}]/;
  const roleOffenders = files.filter((f) => f !== "lib/platform/customer/population.ts" && ROLE_INLINE.test(code(read(f))));
  check("no inline role-USER population predicate outside population.ts", roleOffenders.length === 0, roleOffenders);
  const SITES = [
    "lib/platform/customer/attention.ts", "lib/platform/customer/overview.ts", "lib/platform/customer/recently-joined.ts",
    "lib/platform/policy-groups-read.ts", "lib/platform/policy-assignment-health.ts", "lib/platform/policies/policy-group-detail.ts",
    "lib/platform/policies/policy-group-lifecycle-read.ts", "lib/platform/policies/reconcile-beta.ts", "lib/platform/security/analytics.ts",
    "lib/platform/onboarding/import-facts.ts", "app/api/platform/growth-revenue/users/route.ts",
  ];
  const notImporting = SITES.filter((f) => !/from "@\/lib\/platform\/customer\/population"/.test(read(f)));
  check(`the ${SITES.length} population readers import the shared module`, notImporting.length === 0, notImporting);
}

console.log("\n4. windows — one source (X9), rolling reads marked (X5)");
check("PRODUCT_ANALYTICS_WINDOW_DAYS is ENGAGEMENT_WINDOW_DAYS.mau", PRODUCT_ANALYTICS_WINDOW_DAYS === ENGAGEMENT_WINDOW_DAYS.mau);
{
  const pac = code(read("lib/platform/growth/product-analytics-core.ts"));
  check("pac defines its window from ENGAGEMENT_WINDOW_DAYS (no literal 30)", /PRODUCT_ANALYTICS_WINDOW_DAYS = ENGAGEMENT_WINDOW_DAYS\.mau;/.test(pac));
  check("pac's UTC-day DAU / WAU read the constant, never a literal",
    /activeUsers\(sets, today, ENGAGEMENT_WINDOW_DAYS\.dau\)/.test(pac) && /activeUsers\(sets, today, ENGAGEMENT_WINDOW_DAYS\.wau\)/.test(pac)
      && !/activeUsers\(sets, today, \d+\)/.test(pac) && !/lastNDays\(today, \d+\)/.test(pac));
  const act = read("lib/platform/activity/activity.ts");
  check("activity: UTC-day engaged windows read the constant", /activeUsers\(sets, today, W\.dau\), weekly: activeUsers\(sets, today, W\.wau\), monthly: activeUsers\(sets, today, W\.mau\)/.test(act)
    && !/activeUsers\(sets, today, \d+\)/.test(code(act)));
  check("activity: every rolling since() carries the X5 note, and none takes a literal",
    (act.match(/since\(W\.(dau|wau|mau)\)\), \/\/ rolling — see PLATFORM-INTELLIGENCE X5/g) ?? []).length === 6 && !/since\(\d+\)/.test(code(act)));
  const signups = read("app/api/platform/growth-revenue/signups/route.ts");
  check("signups: rolling week / month carry the X5 note and read the constant",
    /rolling — see PLATFORM-INTELLIGENCE X5/.test(signups) && /ENGAGEMENT_WINDOW_DAYS\.wau \* DAY_MS/.test(signups) && /ENGAGEMENT_WINDOW_DAYS\.mau \* DAY_MS/.test(signups));
  const growth = read("lib/platform/growth/growth.ts");
  check("growth: rolling 'Returning (7d)' carries the X5 note and reads the constant",
    /rolling — see PLATFORM-INTELLIGENCE X5[^\n]*\n\s*const weekAgo = new Date\(now\.getTime\(\) - ENGAGEMENT_WINDOW_DAYS\.wau \* DAY_MS\);/.test(growth));
}

console.log("\n5. copy — the ENGINEERING renames");
{
  const has = (f: string, s: string) => read(f).includes(s);
  const COPY: Array<[file: string, now: string, was: string]> = [
    ["components/platform/widgets/OpsActivityWidget.tsx", 'label="Sign-ins · 1 d"', 'label="DAU"'],
    ["components/platform/widgets/OpsActivityWidget.tsx", 'label="Sign-ins · 7 d"', 'label="WAU"'],
    ["components/platform/widgets/OpsActivityWidget.tsx", 'label="Sign-ins · 30 d"', 'label="MAU"'],
    ["components/platform/leads/GrowthLead.tsx", '{ id: "present", label: "Present" }', 'label: "Signed in"'],
    ["components/platform/widgets/CsCustomersWidget.tsx", '<Row label="Live sessions"', "Signed-in sessions"],
    ["components/platform/widgets/security-posture-view.ts", 'label: "Live sessions"', '"Active sessions"'],
    ["components/platform/widgets/OpsUsersWidget.tsx", 'label="Accounts with a live session"', 'label="Live sessions"'],
    ["components/platform/widgets/OpsUsersWidget.tsx", 'label="Accounts with a live session"', 'label="With a live session"'],
    ["components/admin/AdminSecurityConsole.tsx", ">Live sessions</p>", ">Active sessions</p>"],
    ["components/platform/leads/GrowthLead.tsx", "in 7 d · ${n(p.active.monthly.engaged)} in 30 d (UTC days)", "this week"],
    ["components/platform/leads/GrowthLead.tsx", "in 7 d · ${n(p.active.monthly.present)} in 30 d (UTC days)", "this week"],
    ["lib/presence/definitions.ts", 'label: "today"', "active today"],
    ["components/platform/widgets/GrowthSignupsWidget.tsx", "engaged · 7 d", "active this week"],
    ["lib/platform/economics/snapshot-core.ts", 'label: "Engaged customers · this cycle"', "Active customers · this cycle"],
    ["lib/platform/economics/snapshot-core.ts", 'label: "Cost per engaged customer"', "Cost per active customer"],
    ["components/platform/leads/customer-success-model.ts", "open customer accounts · reasons below", "active customers"],
    ["components/platform/leads/CustomerSuccessLead.tsx", "open customer accounts · strict funnel", "active customers"],
    ["components/platform/widgets/CsCustomersWidget.tsx", "open customer account${", " active customer${"],
    ["components/platform/widgets/GrowthProductAnalyticsWidget.tsx", 'label="Returned (ever)"', "Returning ever"],
    ["components/platform/widgets/CsCustomersWidget.tsx", '<Row label="Last interaction"', '"Last active"'],
  ];
  for (const [f, now, was] of COPY) check(`${path.basename(f)}: "${now}" (was "${was}")`, has(f, now) && !code(read(f)).includes(was));
}

console.log("\n6. live sessions vs accounts; the auth lockout is not the population rule");
{
  const reg = read("lib/platform/intelligence/metrics/registry.ts");
  const entry = (id: string) => reg.slice(reg.indexOf(`id: "${id}"`), reg.indexOf("\n  },\n", reg.indexOf(`id: "${id}"`)));
  const live = entry("live-sessions"), accts = entry("accounts-with-live-session");
  check("live-sessions@1 is explicitly the SESSION count and no longer claims the Growth account tile",
    /A SESSION count \(UserSession rows, never accounts\)/.test(live) && !/OpsUsersWidget/.test(live) && !/growth-revenue\/users/.test(live));
  check("accounts-with-live-session@1 is the ACCOUNT count behind Growth's tile",
    /An ACCOUNT count/.test(accts) && /OpsUsersWidget\.tsx", reads: "data\.withLiveSession"/.test(accts) && /growth-revenue\/users\/route\.ts/.test(accts));
  check("session-proof says its deletionScheduledAt lock is the AUTH rule (#291), not the population rule",
    /\/\/ AUTH lockout \(#291\)[^\n]*NOT the Open-account population rule[^\n]*\n\s*user:\s+\{ is: \{ [^\n]*deactivatedAt: null, deletionScheduledAt: null/.test(read("lib/auth/session-proof.ts")));
  check("population.ts says the same from its side", /Population rule only: a session's lockout is the separate AUTH rule \(#291, liveSessionWhere\)/.test(read("lib/platform/customer/population.ts")));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
