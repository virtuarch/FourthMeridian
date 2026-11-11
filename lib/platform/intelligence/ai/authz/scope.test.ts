/**
 * lib/platform/intelligence/ai/authz/scope.test.ts  (Platform AI P1b — the ONE scope, I-7)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/authz/scope.test.ts
 *
 * 1. scopeFromGuard admits only a real grant for exactly that area and that operator:
 *    SYSTEM_ADMIN / break-glass (grant null) ⇒ refused; a grant for another area ⇒ refused;
 *    operator mismatch ⇒ refused; matching ⇒ allowed.
 * 2. bindArea binds only an issued scope with a single-area token for that area; the
 *    break-glass all-areas token, another area's token, a forged scope or a SYSTEM
 *    incident token ⇒ refused. A bound area reads ITS surface only.
 * 3. Static: both callers (ask route, conversations' area guard) call scope.ts and keep no
 *    binder of their own; nothing under Platform AI reads the SYSTEM_ADMIN kill switch or the
 *    break-glass decision; no "ALL" / wildcard area in the contract, registry or scope.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { UserRole, type PlatformArea } from "@prisma/client";
import { metricAccessFor } from "@/lib/platform/intelligence/metrics/access";
import { incidentAudienceFor, systemIncidentAudience } from "@/lib/platform/incidents/intelligence/audience";
import { ALL_PLATFORM_AREAS } from "@/lib/platform/policy";
import { bindArea, inScope, isScopedArea, scopeFromGuard, scopeFromGuards, type ScopeAuth, type ScopedArea } from "./scope";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const ROOT = process.cwd();
const src = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

const OP = "cop0000000000000000000001";
const OTHER = "cop0000000000000000000002";
const operator = (area: PlatformArea, id = OP, level: "READ" | "WRITE" | "CONTROL" = "READ"): ScopeAuth =>
  ({ user: { id, role: UserRole.USER }, grant: { area, level } });
const breakGlass = (id = OP): ScopeAuth => ({ user: { id, role: UserRole.SYSTEM_ADMIN }, grant: null });

console.log("1. scopeFromGuard — the I-7 rule");
{
  check("a SYSTEM_ADMIN on break-glass (grant null) is NEVER in scope, for any area",
    ALL_PLATFORM_AREAS.every((a) => scopeFromGuard(breakGlass(), a, OP) === null && !inScope(breakGlass(), a, OP)));
  check("…nor a SYSTEM_ADMIN that somehow carries a grant (belt and braces: the adapter never issues one)",
    scopeFromGuard({ user: { id: OP, role: UserRole.SYSTEM_ADMIN }, grant: { area: "PLATFORM_OPS", level: "READ" } }, "PLATFORM_OPS", OP) === null);
  check("a grant for ANOTHER area ⇒ refused", scopeFromGuard(operator("CUSTOMER_SUCCESS"), "PLATFORM_OPS", OP) === null);
  check("operator mismatch (the guard's session user is not the operator) ⇒ refused", scopeFromGuard(operator("PLATFORM_OPS", OTHER), "PLATFORM_OPS", OP) === null);
  check("no guard result / an empty operator id ⇒ refused",
    scopeFromGuard(null, "PLATFORM_OPS", OP) === null && scopeFromGuard(undefined, "PLATFORM_OPS", OP) === null && scopeFromGuard(operator("PLATFORM_OPS", ""), "PLATFORM_OPS", "") === null);
  check("a non-registry area string ⇒ refused", scopeFromGuard({ user: { id: OP, role: UserRole.USER }, grant: { area: "ALL" as PlatformArea, level: "READ" } }, "ALL" as PlatformArea, OP) === null);
  const s = scopeFromGuard(operator("PLATFORM_OPS"), "PLATFORM_OPS", OP);
  check("a matching grant, area and operator ⇒ allowed: an issued ScopedArea for that area and operator",
    !!s && isScopedArea(s) && s.area === "PLATFORM_OPS" && s.operatorId === OP);
  check("every grant level READ / WRITE / CONTROL scopes READ the same way (Platform AI is read-only)",
    (["READ", "WRITE", "CONTROL"] as const).every((l) => !!scopeFromGuard(operator("SECURITY_OPS", OP, l), "SECURITY_OPS", OP)));
  const forged = { area: "PLATFORM_OPS", operatorId: OP } as unknown as ScopedArea;
  check("a hand-built ScopedArea is not issued (isScopedArea false)", !isScopedArea(forged) && !isScopedArea({ ...s }));
  const many = scopeFromGuards([
    { area: "MERCHANT_OPS", auth: operator("MERCHANT_OPS") },
    { area: "PLATFORM_OPS", auth: operator("PLATFORM_OPS") },
    { area: "CUSTOMER_SUCCESS", auth: operator("CUSTOMER_SUCCESS", OTHER) },
    { area: "SECURITY_OPS", auth: breakGlass() },
    { area: "GROWTH_REVENUE", auth: operator("PLATFORM_OPS") },
    { area: "PLATFORM_OPS", auth: operator("PLATFORM_OPS") },
  ], OP);
  check("scopeFromGuards: only the matching results, registry order, each area once (SA, mismatched operator and wrong-area grants dropped)",
    many.map((x) => x.area).join() === "PLATFORM_OPS,MERCHANT_OPS", many.map((x) => x.area));
}

console.log("\n2. bindArea — binds only an issued scope with that area's own token");
{
  const auth = operator("PLATFORM_OPS");
  const scope = scopeFromGuard(auth, "PLATFORM_OPS", OP)!;
  const tokens = { metricToken: metricAccessFor(auth), incidentToken: incidentAudienceFor(auth) };
  const b = bindArea(scope, tokens);
  check("matching scope + that area's token ⇒ a binding labelled with the area's registry label", !!b && b.surfaceLabel === "Platform Operations");
  check("…whose pages are that surface's (or platform-wide) only — never another area's", !!b && b.listPages({}).length > 0 && b.listPages({}).every((t) => t.area === "PLATFORM_OPS" || t.area === null));
  check("…and whose metrics are that area's only (a CS-only metric is invisible)", !!b && b.describeMetric("cs-needs-help") === null && b.listMetrics({}).length > 0);
  const saToken = metricAccessFor({ user: { role: UserRole.SYSTEM_ADMIN }, grant: null });
  check("the break-glass ALL-AREAS metric token ⇒ refused (no all-areas scope, I-7)", bindArea(scope, { metricToken: saToken, incidentToken: null }) === null);
  const csAuth = operator("CUSTOMER_SUCCESS");
  check("another area's token ⇒ refused", bindArea(scope, { metricToken: metricAccessFor(csAuth), incidentToken: null }) === null);
  check("no token ⇒ refused", bindArea(scope, { metricToken: null, incidentToken: null }) === null);
  check("a forged (unissued) scope ⇒ refused", bindArea({ area: "PLATFORM_OPS", operatorId: OP } as unknown as ScopedArea, tokens) === null);
  check("the SYSTEM incident token ⇒ refused (never above the area's own tier)", bindArea(scope, { metricToken: tokens.metricToken, incidentToken: systemIncidentAudience() as never }) === null);
  const csScope = scopeFromGuard(csAuth, "CUSTOMER_SUCCESS", OP)!;
  const cs = bindArea(csScope, { metricToken: metricAccessFor(csAuth), incidentToken: incidentAudienceFor(csAuth) });
  check("a CS scope binds the CS surface (its own label, its own metrics)", !!cs && cs.surfaceLabel === "Customer Success" && cs.describeMetric("cs-needs-help") !== null);
  check("every Platform area binds through its own case", ALL_PLATFORM_AREAS.every((a) => {
    const au = operator(a); const sc = scopeFromGuard(au, a, OP)!;
    return !!bindArea(sc, { metricToken: metricAccessFor(au), incidentToken: incidentAudienceFor(au) });
  }));
}

console.log("\n3. static — one implementation, both callers, no break-glass, no wildcard");
{
  const SCOPE = "lib/platform/intelligence/ai/authz/scope.ts";
  const scope = code(src(SCOPE));
  const route = code(src("app/api/platform/ai/ask/route.ts"));
  const access = code(src("app/api/platform/ai/conversations/area-access.ts"));
  check("the ask route and the conversations' area guard both import scopeFromGuard + bindArea from authz/scope",
    [route, access].every((s) => /import \{ bindArea, scopeFromGuard \} from "@\/lib\/platform\/intelligence\/ai\/authz\/scope";/.test(s)));
  check("neither keeps a binder of its own (no bindingFor / local bindArea / literal-surface accessor call)",
    [route, access].every((s) => !/function bindingFor|function bindArea|retrieveMetric\(|listNavigationTargets\(|resolveNavigationTarget\(|describeMetric\(|listMetrics\(/.test(s)));
  check("the route scopes its primary area and each other area from ITS OWN guard result",
    /scopeFromGuard\(auth, area, auth\.user\.id\)/.test(route) && /scopeFromGuard\(otherAuth, other, auth\.user\.id\)/.test(route));
  check("the area guard scopes the conversation's own area for the conversation's operator", /scopeFromGuard\(auth, area, operatorId\)/.test(access));
  check("scope.ts mints nothing and guards nothing (tokens come from its guarded callers)",
    !/metricAccessFor\(|incidentAudienceFor\(|systemIncidentAudience|require(?:Fresh)?PlatformAccess\(|@\/lib\/db|systemDb/.test(scope));
  check("scope.ts is server-only", /^import "server-only";/m.test(src(SCOPE)));

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(path.join(ROOT, dir))) {
      const rel = `${dir}/${e}`;
      if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) files.push(rel);
    }
  };
  walk("lib/platform/intelligence/ai");
  walk("app/api/platform/ai");
  const importers = [...files, ...["app", "lib", "components", "jobs"].flatMap((d) => { const out: string[] = []; const w = (x: string) => { for (const e of readdirSync(path.join(ROOT, x))) { const r = `${x}/${e}`; if (e === "node_modules" || e.startsWith(".")) continue; if (statSync(path.join(ROOT, r)).isDirectory()) w(r); else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(r); } }; w(d); return out; })]
    .filter((f, i, a) => a.indexOf(f) === i && /intelligence\/ai\/authz\/scope["']|from "\.\.?\/(?:authz\/)?scope"/.test(src(f)) && f !== SCOPE);
  // P2: the turn boundary (validates route-issued ScopedAreas) and the per-call recheck (the same I-7 rule on each fresh guard) consume it too.
  check("scope.ts is imported (outside tests) only by the ask route, the conversations' area guard, the turn boundary and the per-call recheck",
    importers.sort().join() === "app/api/platform/ai/ask/route.ts,app/api/platform/ai/conversations/area-access.ts,lib/platform/intelligence/ai/authz/boundary.ts,lib/platform/intelligence/ai/authz/recheck.ts", importers);

  const breakGlassReaders = files.filter((f) => /DISABLE_SYSTEM_ADMIN|isSystemAdminDisabled|decideBreakGlass|decideAdminApiAccess/.test(code(src(f))));
  check("I-7: nothing under lib/platform/intelligence/ai/** or app/api/platform/ai/** reads the SYSTEM_ADMIN kill switch or the break-glass decision",
    breakGlassReaders.length === 0, breakGlassReaders);
  const typed = ["lib/platform/intelligence/ai/tools/contract.ts", "lib/platform/intelligence/ai/tools/registry.ts", SCOPE].map((f) => code(src(f)));
  check("I-7: no \"ALL\" / \"*\" / wildcard area value in the contract, the registry or the scope",
    typed.every((s) => !/"ALL"|'ALL'|"\*"|ALL_AREAS|WILDCARD|wildcard:/i.test(s)));
  check("…the contract's area type is a non-empty tuple of PlatformArea (no string escape hatch)",
    /export type ToolAreas = readonly \[PlatformArea, \.\.\.PlatformArea\[\]\];/.test(typed[0]) && !/areas:\s*(?:string|readonly string)/.test(typed[0]));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
