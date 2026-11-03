/**
 * lib/platform/intelligence/metrics/registry.test.ts  (Platform Intelligence — metric registry pins)
 *
 * The registry DESCRIBES metrics the Platform already computes; these pins keep
 * every description true to the code:
 *   1. structure — ids unique, versions explicit, every metric has a permission
 *      and an identity tier, UNAVAILABLE carries a reason (metricDefinitionProblems);
 *   2. per metric, by SOURCE — the computing function (and each numerator /
 *      denominator / window symbol) is exported by its module; each route → reader
 *      hop calls the next; the compute function is the one the chain or the UI
 *      tile actually calls; every tile reads the figure; every permission route
 *      guards with exactly its requirePlatformAccess(area, level);
 *   3. definition versions that the code carries itself agree with the registry;
 *   4. the accessor — permission-filtered, token-minted, forged tokens refused,
 *      no existence oracle, definitions only.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/metrics/registry.test.ts
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { UserRole } from "@prisma/client";
import { METRICS, metricDefinitionProblems, metricKey, type MetricDefinition } from "./registry";
import { describeMetric, isMetricAccessToken, listMetrics, metricAccessFor, type MetricAccessToken } from "./access";
import { PROVIDER_OUTCOME_DEFINITION } from "@/lib/platform/verdicts/provider-outcome";
import { PROVIDER_CONNECTION_DEFINITION } from "@/lib/platform/verdicts/provider-connection";
import { ENGAGEMENT_WINDOW_DAYS } from "@/lib/presence/definitions";
import { PRODUCT_ANALYTICS_WINDOW_DAYS } from "@/lib/platform/growth/product-analytics-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const src = (file: string): string | null => {
  const p = path.join(ROOT, file);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};
/** Comments stripped, so a symbol named only in prose never satisfies a pin. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exportsSymbol = (s: string, sym: string) =>
  new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let)\\s+${esc(sym)}\\b`).test(code(s));
const callsSymbol = (s: string, sym: string) => new RegExp(`${esc(sym)}\\s*[<(]`).test(code(s));
/** True when `file` imports from `module` (resolving "@/…" and "./…" specifiers, with or without /index). */
const importsModule = (file: string, module: string): boolean => {
  const s = src(file);
  if (!s) return false;
  const want = module.replace(/\.tsx?$/, "").replace(/\/index$/, "");
  for (const mm of s.matchAll(/from\s+["']([^"']+)["']/g)) {
    const spec = mm[1];
    const resolved = spec.startsWith("@/") ? spec.slice(2)
      : spec.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)) : null;
    if (resolved && resolved.replace(/\/index$/, "") === want) return true;
  }
  return false;
};

console.log("\nmetric registry\n");

// ── 1. structure ─────────────────────────────────────────────────────────────
console.log("structure");
{
  const keys: string[] = METRICS.map(metricKey);
  check(`ids@versions are unique (${keys.length} metrics)`, new Set(keys).size === keys.length, keys.join(", "));
  check("ids are unique across versions too (one entry per id today; a new version is a new entry, never an edit)",
    new Set(METRICS.map((m) => m.id)).size === METRICS.length);
  const problems = METRICS.flatMap(metricDefinitionProblems);
  check("every definition is structurally sound (explicit version, permission + identity tier, provenance reason, tile, drill)",
    problems.length === 0, problems.join("; "));
  const REQUIRED = ["provider-outcome@1", "provider-connection@1", "ai-fleet-spend-status@1", "presence-state@1", "engaged-users@1",
    "incident-broken-now@1", "incident-alertable@1", "merchant-identity-linked@1", "cs-needs-help@1", "growth-registrations@1"];
  check("the required existing authorities are all registered", REQUIRED.every((k) => keys.includes(k)), REQUIRED.filter((k) => !keys.includes(k)).join(", "));

  // The validator itself refuses what the rules forbid (the registry holds no UNAVAILABLE entry today).
  const base = METRICS[0];
  const bad = (over: Partial<MetricDefinition>) => metricDefinitionProblems({ ...base, ...over });
  check("validator: UNAVAILABLE without a reason is refused", bad({ provenance: { class: "UNAVAILABLE", reason: " " } }).some((p) => p.includes("reason")));
  check("validator: UNAVAILABLE with a reason passes the provenance rule", !bad({ provenance: { class: "UNAVAILABLE", reason: "no billing source exists" } }).some((p) => p.includes("provenance")));
  check("validator: no permission is refused", bad({ permission: [] }).some((p) => p.includes("permission")));
  check("validator: a non-integer / missing version is refused", bad({ version: 1.5 }).length > 0 && bad({ version: 0 }).length > 0);
  check("validator: customer identity outside CUSTOMER_SUCCESS is refused",
    bad({ permission: [{ area: "PLATFORM_OPS", level: "READ", identityTier: "CUSTOMER_SUCCESS", route: "x" }] }).some((p) => p.includes("identity")));
  check("validator: ESTIMATED must say what is estimated", bad({ provenance: { class: "ESTIMATED", note: "" } }).length > 0);
}

// ── 2. per-metric source pins ────────────────────────────────────────────────
console.log("per-metric source pins");
for (const m of METRICS) {
  const k = metricKey(m);
  const refs = [m.compute, m.numerator.source, ...(m.denominator ? [m.denominator.source] : []), ...(m.window.source ? [m.window.source] : [])];
  const missing = refs.filter((r) => { const s = src(r.module); return !s || !exportsSymbol(s, r.symbol); }).map((r) => `${r.module}#${r.symbol}`);
  check(`${k}: compute / numerator / denominator / window symbols are exported where named`, missing.length === 0, missing.join(", "));

  // The chain: each hop calls the next; the next hop's file exports that symbol.
  const hopProblems: string[] = [];
  m.path.forEach((h, i) => {
    const s = src(h.file);
    if (!s) { hopProblems.push(`${h.file} missing`); return; }
    if (!callsSymbol(s, h.calls)) hopProblems.push(`${h.file} does not call ${h.calls}`);
    const next = m.path[i + 1];
    if (next) {
      const ns = src(next.file);
      const owner = h.calls.split(".")[0];
      if (!ns || !exportsSymbol(ns, owner)) hopProblems.push(`${next.file} does not export ${owner}`);
    }
  });
  check(`${k}: route → reader chain holds hop by hop (${m.path.map((h) => path.basename(h.file)).join(" → ")})`, hopProblems.length === 0, hopProblems.join("; "));

  // The compute function is the one the chain or the UI tile actually calls.
  const last = m.path[m.path.length - 1];
  const lastCallsCompute = last.calls === m.compute.symbol
    && (last.file === m.compute.module || importsModule(last.file, m.compute.module));
  const tileCallsCompute = m.tiles.some((t) => t.reads.startsWith(`${m.compute.symbol}(`)
    && callsSymbol(src(t.component) ?? "", m.compute.symbol) && importsModule(t.component, m.compute.module));
  check(`${k}: ${m.compute.symbol} is THE function the chain or its tile calls (no duplicate maths)`, lastCallsCompute || tileCallsCompute,
    `last hop ${last.file} calls ${last.calls}`);

  const tileProblems = m.tiles.filter((t) => { const s = src(t.component); return !s || !code(s).includes(t.reads); }).map((t) => `${t.component} lacks "${t.reads}"`);
  check(`${k}: every tile reads the figure`, tileProblems.length === 0, tileProblems.join("; "));

  const gateProblems = m.permission.filter((p) => {
    const s = src(p.route);
    return !s || !new RegExp(`require(?:Fresh)?PlatformAccess\\(\\s*"${p.area}"\\s*,\\s*"${p.level}"\\s*\\)`).test(code(s));
  }).map((p) => `${p.route} not guarded by ${p.area}/${p.level}`);
  check(`${k}: every permission route guards with exactly its requirePlatformAccess(area, level)`, gateProblems.length === 0, gateProblems.join("; "));

  check(`${k}: the first hop is a permission route (the metric is read only under its gate)`,
    m.permission.some((p) => p.route === m.path[0].file), m.path[0].file);

  if ("api" in m.drill) {
    const route = path.join("app", m.drill.api.split("?")[0], "route.ts");
    check(`${k}: the drill records route exists (${m.drill.api})`, existsSync(path.join(ROOT, route)), route);
  }
}

// ── 3. definitions the code versions itself ─────────────────────────────────
console.log("definition versions and windows agree with the code");
{
  const by = (id: string) => METRICS.find((m) => m.id === id)!;
  check("provider-outcome version = PROVIDER_OUTCOME_DEFINITION.version", by("provider-outcome").version === PROVIDER_OUTCOME_DEFINITION.version);
  check("provider-connection version = PROVIDER_CONNECTION_DEFINITION.version",
    by("provider-connection").version === (PROVIDER_CONNECTION_DEFINITION as { version: number }).version);
  check("engaged-users: Growth's 30-day window is PB-10's MAU window (ENGAGEMENT_WINDOW_DAYS.mau = PRODUCT_ANALYTICS_WINDOW_DAYS)",
    ENGAGEMENT_WINDOW_DAYS.mau === PRODUCT_ANALYTICS_WINDOW_DAYS && ENGAGEMENT_WINDOW_DAYS.dau === 1 && ENGAGEMENT_WINDOW_DAYS.wau === 7);
  check("ai-fleet-spend-status: the registered 24 h window is BUDGET_WINDOW_HOURS",
    /export const BUDGET_WINDOW_HOURS = 24;/.test(src("lib/platform/ai/ai-budget.ts") ?? "") && by("ai-fleet-spend-status").label.includes("24 h"));
}

// ── 4. the accessor ──────────────────────────────────────────────────────────
console.log("accessor (definitions only, permission-filtered, token-minted)");
{
  const user = (role: UserRole) => ({ role });
  const tok = (area: string, level: string) => metricAccessFor({ user: user(UserRole.USER), grant: { area, level } as never })!;
  const ops = tok("PLATFORM_OPS", "READ");
  const cs = tok("CUSTOMER_SUCCESS", "READ");
  const mo = tok("MERCHANT_OPS", "READ");
  const admin = metricAccessFor({ user: user(UserRole.SYSTEM_ADMIN), grant: null })!;

  check("a grant mints a token; a non-admin with no grant mints none", isMetricAccessToken(ops) && metricAccessFor({ user: user(UserRole.USER), grant: null }) === null);
  const opsKeys = listMetrics(ops).map(metricKey);
  check("PLATFORM_OPS READ lists exactly the metrics with a PLATFORM_OPS permission",
    JSON.stringify(opsKeys) === JSON.stringify(METRICS.filter((m) => m.permission.some((p) => p.area === "PLATFORM_OPS")).map(metricKey)), opsKeys.join(","));
  check("…and never a CS-only or Growth metric", !opsKeys.includes("cs-needs-help@1") && !opsKeys.includes("presence-state@1") && !opsKeys.includes("engaged-users@1"));
  const csIncident = describeMetric(cs, "incident-broken-now");
  check("a CS caller sees the shared incident metric with ONLY its own permission entry (CUSTOMER_SUCCESS identity tier)",
    !!csIncident && csIncident.permission.length === 1 && csIncident.permission[0].area === "CUSTOMER_SUCCESS" && csIncident.permission[0].identityTier === "CUSTOMER_SUCCESS");
  const opsIncident = describeMetric(ops, "incident-broken-now@1");
  check("an Ops caller sees it identity-free (OPS tier only)", !!opsIncident && opsIncident.permission.every((p) => p.identityTier === "OPS"));
  check("no existence oracle: an invisible metric reads exactly like an unknown one (null)",
    describeMetric(mo, "cs-needs-help") === null && describeMetric(mo, "no-such-metric") === null && describeMetric(mo, "cs-needs-help@1") === null);
  check("describeMetric by bare id = the highest version; by id@version = that version", describeMetric(mo, "merchant-identity-linked")?.version === 1 && describeMetric(mo, "merchant-identity-linked@2") === null);
  check("SYSTEM_ADMIN break-glass sees every metric", listMetrics(admin).length === METRICS.length);
  check("domain and area filters narrow, never widen",
    listMetrics(ops, { domain: "providers" }).every((m) => m.domain === "providers") && listMetrics(ops, { domain: "providers" }).length === 2
    && listMetrics(ops, { area: "CUSTOMER_SUCCESS" }).length === 0 && listMetrics(admin, { area: "MERCHANT_OPS" }).map(metricKey).join() === "merchant-identity-linked@1");
  const forged = Object.freeze({ grants: [{ area: "PLATFORM_OPS", level: "CONTROL" }] }) as unknown as MetricAccessToken;
  check("a hand-built / cast token is refused at runtime (lists nothing, describes nothing)",
    !isMetricAccessToken(forged) && listMetrics(forged).length === 0 && describeMetric(forged, "provider-outcome") === null);
  check("a minted token cannot be widened after minting (frozen)", (() => { try { (ops.grants as unknown as unknown[]).push({ area: "CUSTOMER_SUCCESS", level: "CONTROL" }); return false; } catch { return true; } })());
  check("WRITE satisfies READ (level rank), a lower level does not satisfy a higher one",
    listMetrics(tok("PLATFORM_OPS", "WRITE")).length === opsKeys.length);
  const listed = listMetrics(admin);
  check("definitions only: no entry carries a value, count or figure field",
    listed.every((m) => !("value" in m) && !("count" in m) && !("figure" in m)));

  // Guard provenance: the accessor is reached only from tests, or from a route that destructures its own guard.
  const importers: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (e === "node_modules" || e.startsWith(".")) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e) && /intelligence\/metrics\/access["']/.test(readFileSync(p, "utf8"))) importers.push(path.relative(ROOT, p));
    }
  };
  for (const d of ["app", "lib", "components", "jobs"]) if (existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  const badImporters = importers.filter((f) => !f.endsWith(".test.ts")
    && !(f.startsWith("app/api/") && /const \[(\w+), \w+\] = await require(?:Fresh)?PlatformAccess\(/.test(readFileSync(path.join(ROOT, f), "utf8"))));
  check("access.ts is imported only by tests or by API routes that mint from their own requirePlatformAccess result", badImporters.length === 0, badImporters.join(", "));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
