/**
 * lib/platform/ai/platform-ai-caps-resolver.test.ts  (Platform AI caps D5 PR1: the pure resolver, no behaviour change)
 *
 * 1. precedence matrix: OPERATOR_OVERRIDE > PLATFORM_SETTING > ENV > TEST_DEFAULT (preview/dev) > REFUSE
 *    for the operator cap; PLATFORM_SETTING > ENV > TEST_DEFAULT > REFUSE for the platform cap;
 * 2. invalid override / setting values are skipped (the next source wins);
 * 3. 0 is a cap of 0 (every turn refused), never "unlimited";
 * 4. the code ceilings ($20 / $100) clamp override / setting with the clamped flag;
 *    ENV is NOT clamped in this PR (pins today's behaviour for S2's ruling);
 * 5. the test default is preview/development only; Production with nothing set ⇒ CAP_MISSING;
 * 6. equivalence: the production call (override + settings null) equals the PRE-D5 resolver,
 *    a frozen copy below, across the env matrix; static pin on the call site.
 * No database, no provider, no env file.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/ai/platform-ai-caps-resolver.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PLATFORM_AI_OPERATOR_CAP_CEILING_USD, PLATFORM_AI_PLATFORM_CAP_CEILING_USD, PLATFORM_AI_SPEND_TEST_DEFAULTS,
  envOnlyCapsInput, platformAiSpendDecision, resolvePlatformAiCaps, resolvePlatformAiSpendCaps, toResolvedCaps,
  type CapInputs, type PlatformAiCapOutcome, type PlatformAiCapsInput, type ResolvedCaps,
} from "./platform-ai-spend.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
const strip = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const input = (p: Partial<PlatformAiCapsInput>): PlatformAiCapsInput => ({
  operatorRaw: undefined, platformRaw: undefined, vercelEnv: "production",
  operatorOverrideUsd: null, settingPerOperatorUsd: null, settingPlatformUsd: null, ...p,
});
const is = (o: PlatformAiCapOutcome, usd: number, source: string, extra: { askedUsd?: number; clamped?: boolean } = {}) =>
  o.ok && o.usd === usd && o.source === source && o.askedUsd === (extra.askedUsd ?? usd) && o.clamped === (extra.clamped ?? false);
const refused = (o: PlatformAiCapOutcome, cause: string) => !o.ok && o.cause === cause;

// ── the PRE-D5 resolver, frozen verbatim from develop 8f2765f platform-ai-spend.core.ts:89-109 ──
const LEGACY_SHAPE = /^(0|[1-9]\d{0,5})(\.\d{1,2})?$/;
type LegacyOne = { ok: true; usd: number; source: "ENV" | "TEST_DEFAULT" } | { ok: false; cause: "CAP_INVALID" | "CAP_MISSING" };
function legacyOne(raw: string | undefined, vercelEnv: string | undefined, testDefault: number): LegacyOne {
  if (raw === undefined || raw === "") {
    return typeof vercelEnv === "string" && ["preview", "development"].includes(vercelEnv)
      ? { ok: true, usd: testDefault, source: "TEST_DEFAULT" }
      : { ok: false, cause: "CAP_MISSING" };
  }
  if (!LEGACY_SHAPE.test(raw)) return { ok: false, cause: "CAP_INVALID" };
  const usd = Number(raw);
  return Number.isFinite(usd) && usd >= 0 ? { ok: true, usd, source: "ENV" } : { ok: false, cause: "CAP_INVALID" };
}
function legacyResolve(i: CapInputs): ResolvedCaps {
  const op = legacyOne(i.operatorRaw, i.vercelEnv, 10);
  const pl = legacyOne(i.platformRaw, i.vercelEnv, 50);
  if (!op.ok && op.cause === "CAP_INVALID") return { state: "REFUSE", cause: "CAP_INVALID", cap: "OPERATOR" };
  if (!pl.ok && pl.cause === "CAP_INVALID") return { state: "REFUSE", cause: "CAP_INVALID", cap: "PLATFORM" };
  if (!op.ok) return { state: "REFUSE", cause: op.cause, cap: "OPERATOR" };
  if (!pl.ok) return { state: "REFUSE", cause: pl.cause, cap: "PLATFORM" };
  return { state: "OK", operatorUsd: op.usd, platformUsd: pl.usd, source: { operator: op.source, platform: pl.source } };
}

function main() {
  console.log("1. precedence matrix");
  {
    const all = resolvePlatformAiCaps(input({ operatorRaw: "7", platformRaw: "70", vercelEnv: "preview", operatorOverrideUsd: 3, settingPerOperatorUsd: 5, settingPlatformUsd: 60 }));
    check("operator: OVERRIDE beats SETTING, ENV, TEST_DEFAULT", is(all.operator, 3, "OPERATOR_OVERRIDE"), all.operator);
    check("platform: SETTING beats ENV, TEST_DEFAULT", is(all.platform, 60, "PLATFORM_SETTING"), all.platform);
    const noOverride = resolvePlatformAiCaps(input({ operatorRaw: "7", platformRaw: "70", vercelEnv: "preview", settingPerOperatorUsd: 5, settingPlatformUsd: 60 }));
    check("operator: no override ⇒ SETTING beats ENV", is(noOverride.operator, 5, "PLATFORM_SETTING"), noOverride.operator);
    const envOnly = resolvePlatformAiCaps(input({ operatorRaw: "7", platformRaw: "70", vercelEnv: "preview" }));
    check("operator: no override / setting ⇒ ENV beats TEST_DEFAULT", is(envOnly.operator, 7, "ENV"), envOnly.operator);
    check("platform: no setting ⇒ ENV beats TEST_DEFAULT", is(envOnly.platform, 70, "ENV"), envOnly.platform);
    for (const env of ["preview", "development"]) {
      const d = resolvePlatformAiCaps(input({ vercelEnv: env }));
      check(`${env}: nothing set ⇒ TEST_DEFAULT ($${PLATFORM_AI_SPEND_TEST_DEFAULTS.operatorUsd} / $${PLATFORM_AI_SPEND_TEST_DEFAULTS.platformUsd})`,
        is(d.operator, PLATFORM_AI_SPEND_TEST_DEFAULTS.operatorUsd, "TEST_DEFAULT") && is(d.platform, PLATFORM_AI_SPEND_TEST_DEFAULTS.platformUsd, "TEST_DEFAULT"), d);
    }
    const prodNothing = resolvePlatformAiCaps(input({ vercelEnv: "production" }));
    check("production: nothing set ⇒ both REFUSE CAP_MISSING", refused(prodNothing.operator, "CAP_MISSING") && refused(prodNothing.platform, "CAP_MISSING"), prodNothing);
    check("production: nothing set ⇒ ResolvedCaps REFUSE CAP_MISSING OPERATOR", (() => { const r = toResolvedCaps(prodNothing); return r.state === "REFUSE" && r.cause === "CAP_MISSING" && r.cap === "OPERATOR"; })());
    for (const env of [undefined, "", "staging", "Preview", "PRODUCTION"]) {
      const r = resolvePlatformAiCaps(input({ vercelEnv: env }));
      check(`VERCEL_ENV=${JSON.stringify(env)}: no test default ⇒ CAP_MISSING`, refused(r.operator, "CAP_MISSING") && refused(r.platform, "CAP_MISSING"), r);
    }
    const prodSettings = resolvePlatformAiCaps(input({ vercelEnv: "production", operatorOverrideUsd: 4, settingPlatformUsd: 40 }));
    check("production: override + platform setting, no env ⇒ OK from those sources", is(prodSettings.operator, 4, "OPERATOR_OVERRIDE") && is(prodSettings.platform, 40, "PLATFORM_SETTING"), prodSettings);
    const op2 = resolvePlatformAiCaps(input({ vercelEnv: "production", settingPerOperatorUsd: 6 }));
    check("production: per-operator setting alone ⇒ operator OK, platform still CAP_MISSING", is(op2.operator, 6, "PLATFORM_SETTING") && refused(op2.platform, "CAP_MISSING"), op2);
    check("the per-operator setting never feeds the platform cap", (() => { const r = resolvePlatformAiCaps(input({ vercelEnv: "preview", settingPerOperatorUsd: 6 })); return is(r.platform, 50, "TEST_DEFAULT"); })());
    check("a higher source wins over an INVALID env value (env not consulted)", (() => { const r = resolvePlatformAiCaps(input({ operatorRaw: "abc", platformRaw: "$5", settingPerOperatorUsd: 5, settingPlatformUsd: 9 })); return is(r.operator, 5, "PLATFORM_SETTING") && is(r.platform, 9, "PLATFORM_SETTING"); })());
    check("an INVALID env value with no higher source still refuses CAP_INVALID", (() => { const r = resolvePlatformAiCaps(input({ operatorRaw: "5.", vercelEnv: "preview" })); return refused(r.operator, "CAP_INVALID"); })());
  }

  console.log("2. invalid override / setting values are skipped");
  {
    const bad: unknown[] = [-1, 1.5, 0.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.5];
    for (const v of bad) {
      const r = resolvePlatformAiCaps(input({ operatorRaw: "7", platformRaw: "70", operatorOverrideUsd: v as number, settingPerOperatorUsd: v as number, settingPlatformUsd: v as number }));
      check(`${String(v)} skipped ⇒ ENV wins for both caps`, is(r.operator, 7, "ENV") && is(r.platform, 70, "ENV"), r);
    }
    const r = resolvePlatformAiCaps(input({ operatorRaw: "7", operatorOverrideUsd: 2.5, settingPerOperatorUsd: 4 }));
    check("an invalid override falls through to a valid setting", is(r.operator, 4, "PLATFORM_SETTING"), r.operator);
    const t = resolvePlatformAiCaps(input({ vercelEnv: "development", operatorOverrideUsd: -3, settingPerOperatorUsd: -3, settingPlatformUsd: 1.25 }));
    check("invalid override + settings, no env, development ⇒ TEST_DEFAULT", is(t.operator, 10, "TEST_DEFAULT") && is(t.platform, 50, "TEST_DEFAULT"), t);
    const p = resolvePlatformAiCaps(input({ vercelEnv: "production", operatorOverrideUsd: -1, settingPerOperatorUsd: 2.5, settingPlatformUsd: Number.NaN }));
    check("invalid override + settings, nothing else, production ⇒ CAP_MISSING", refused(p.operator, "CAP_MISSING") && refused(p.platform, "CAP_MISSING"), p);
  }

  console.log("3. 0 means refuse every turn, never unlimited");
  {
    const z = resolvePlatformAiCaps(input({ operatorRaw: "7", platformRaw: "70", operatorOverrideUsd: 0, settingPlatformUsd: 0 }));
    check("override 0 wins (operator cap 0)", is(z.operator, 0, "OPERATOR_OVERRIDE"), z.operator);
    check("platform setting 0 wins (platform cap 0)", is(z.platform, 0, "PLATFORM_SETTING"), z.platform);
    const zs = resolvePlatformAiCaps(input({ operatorRaw: "7", settingPerOperatorUsd: 0 }));
    check("per-operator setting 0 wins over ENV", is(zs.operator, 0, "PLATFORM_SETTING"), zs.operator);
    for (const [label, caps] of [["operator", toResolvedCaps(resolvePlatformAiCaps(input({ operatorOverrideUsd: 0, settingPlatformUsd: 50 })))], ["platform", toResolvedCaps(resolvePlatformAiCaps(input({ operatorOverrideUsd: 5, settingPlatformUsd: 0 })))]] as const) {
      const v = platformAiSpendDecision({ caps, operatorGroups: [], platformGroups: [], todayISO: "2026-11-10", operatorInFlight: 0, platformInFlight: 0, reserveUsd: 0.01 });
      check(`a ${label} cap of 0 refuses the very first turn (COST_CAP)`, !v.allowed && v.detail === "COST_CAP" && v.scope === (label === "operator" ? "OPERATOR" : "PLATFORM"), v);
    }
  }

  console.log("4. the code ceilings");
  {
    check("ceilings are $20 operator / $100 platform", PLATFORM_AI_OPERATOR_CAP_CEILING_USD === 20 && PLATFORM_AI_PLATFORM_CAP_CEILING_USD === 100);
    const hi = resolvePlatformAiCaps(input({ operatorOverrideUsd: 500, settingPlatformUsd: 1000 }));
    check("override 500 ⇒ 20, source CEILING, askedUsd 500, clamped", is(hi.operator, 20, "CEILING", { askedUsd: 500, clamped: true }) && hi.operator.ok && hi.operator.askedSource === "OPERATOR_OVERRIDE", hi.operator);
    check("platform setting 1000 ⇒ 100, source CEILING, askedUsd 1000, clamped", is(hi.platform, 100, "CEILING", { askedUsd: 1000, clamped: true }) && hi.platform.ok && hi.platform.askedSource === "PLATFORM_SETTING", hi.platform);
    const ps = resolvePlatformAiCaps(input({ settingPerOperatorUsd: 21 }));
    check("per-operator setting 21 ⇒ 20 clamped (askedSource PLATFORM_SETTING)", is(ps.operator, 20, "CEILING", { askedUsd: 21, clamped: true }) && ps.operator.ok && ps.operator.askedSource === "PLATFORM_SETTING", ps.operator);
    const at = resolvePlatformAiCaps(input({ operatorOverrideUsd: 20, settingPlatformUsd: 100 }));
    check("exactly at the ceiling ⇒ not clamped, own source", is(at.operator, 20, "OPERATOR_OVERRIDE") && is(at.platform, 100, "PLATFORM_SETTING"), at);
    const td = resolvePlatformAiCaps(input({ vercelEnv: "preview" }));
    check("the test defaults sit under the ceilings (not clamped)", td.operator.ok && !td.operator.clamped && td.platform.ok && !td.platform.clamped, td);
    // ENV is deliberately NOT clamped in D5 PR1: today a strict env value up to 999999.99 is the cap.
    // Clamping would lower such a cap (a behaviour change); S2 rules on it in a later PR.
    const envHi = resolvePlatformAiCaps(input({ operatorRaw: "50", platformRaw: "250.75" }));
    check("CURRENT BEHAVIOUR (S2 to rule): ENV above the ceiling is NOT clamped (50 / 250.75, source ENV)", is(envHi.operator, 50, "ENV") && is(envHi.platform, 250.75, "ENV"), envHi);
    check("CURRENT BEHAVIOUR: ENV 999999.99 is honoured as-is", (() => { const r = resolvePlatformAiCaps(input({ operatorRaw: "999999.99", platformRaw: "999999.99" })); return is(r.operator, 999999.99, "ENV") && is(r.platform, 999999.99, "ENV"); })());
    check("ENV keeps its cents (12.50 ⇒ 12.5)", (() => { const r = resolvePlatformAiCaps(input({ operatorRaw: "12.50", platformRaw: "0.01" })); return is(r.operator, 12.5, "ENV") && is(r.platform, 0.01, "ENV"); })());
  }

  console.log("5. equivalence: env-only (production call) ≡ the PRE-D5 resolver");
  {
    const raws: (string | undefined)[] = [undefined, "", "0", "1", "10", "12.5", "12.50", "0.01", "20", "21", "100", "101", "999999.99", "1000000",
      " 5", "5.", "1e3", "-1", "$5", "five", "05", "5.123", "0x10", "Infinity", "NaN"];
    const envs: (string | undefined)[] = ["production", "preview", "development", undefined, "", "staging", "Preview", "PRODUCTION"];
    let cases = 0; const mismatches: unknown[] = [];
    for (const operatorRaw of raws) for (const platformRaw of raws) for (const vercelEnv of envs) {
      const i: CapInputs = { operatorRaw, platformRaw, vercelEnv };
      const want = JSON.stringify(legacyResolve(i));
      const viaNew = JSON.stringify(toResolvedCaps(resolvePlatformAiCaps(envOnlyCapsInput(i))));
      const viaWrapper = JSON.stringify(resolvePlatformAiSpendCaps(i));
      cases++;
      if (viaNew !== want || viaWrapper !== want) mismatches.push({ i, want, viaNew, viaWrapper });
    }
    check(`${cases} env cases: new resolver (nulls) and the wrapper equal the PRE-D5 result exactly`, mismatches.length === 0, mismatches.slice(0, 3));
    check("envOnlyCapsInput passes null for override and both settings", (() => { const e = envOnlyCapsInput({ operatorRaw: "1", platformRaw: "2", vercelEnv: "production" }); return e.operatorOverrideUsd === null && e.settingPerOperatorUsd === null && e.settingPlatformUsd === null && e.operatorRaw === "1" && e.platformRaw === "2" && e.vercelEnv === "production"; })());
    const src = strip("lib/platform/ai/platform-ai-spend.ts");
    check("the production call site resolves env-only through the new resolver (override + settings null)",
      /const caps = toResolvedCaps\(resolvePlatformAiCaps\(envOnlyCapsInput\(opts\.caps \?\? env\.platformAiSpendCapInputs\)\)\);/.test(src));
    check("the production call site passes no override / setting value", !/operatorOverrideUsd|settingPerOperatorUsd|settingPlatformUsd/.test(src));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}
main();
