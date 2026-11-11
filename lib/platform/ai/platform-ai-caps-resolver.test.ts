/**
 * lib/platform/ai/platform-ai-caps-resolver.test.ts  (Platform AI caps D5 PR1 + PR2: the pure resolver)
 *
 * 1. precedence matrix: OPERATOR_OVERRIDE > PLATFORM_SETTING > ENV > TEST_DEFAULT (preview/dev) > REFUSE
 *    for the operator cap; PLATFORM_SETTING > ENV > TEST_DEFAULT > REFUSE for the platform cap;
 * 2. a present but invalid SETTING refuses CAP_INVALID (S2 R2, 09fp); since D5 PR4 a present
 *    invalid OVERRIDE refuses CAP_INVALID OPERATOR too (S2 09fq); null = absent = not set;
 * 3. 0 is a cap of 0 (every turn refused), never "unlimited";
 * 4. the code ceilings ($20 / $100) clamp EVERY source with the clamped flag — ENV too
 *    since D5 PR2 (S2 E1); an INVALID env refuses even when a higher source wins (S2 E2);
 * 5. the test default is preview/development only; Production with nothing set ⇒ CAP_MISSING;
 * 6. equivalence: env-only resolution equals the PRE-D5 resolver, a frozen copy below,
 *    across the env matrix, with the one ruled change (E1: an ENV value above its ceiling
 *    is lowered to it, source CEILING) applied to the legacy result; static pins on the call site.
 * No database, no provider, no env file.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/ai/platform-ai-caps-resolver.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PLATFORM_AI_OPERATOR_CAP_CEILING_USD, PLATFORM_AI_PLATFORM_CAP_CEILING_USD, PLATFORM_AI_SPEND_TEST_DEFAULTS,
  capSettingUsdOf, envOnlyCapsInput, parseOperatorCapRow, platformAiSpendDecision, platformAiTurnsThatFit, resolvePlatformAiCaps, resolvePlatformAiSpendCaps, toResolvedCaps,
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

/** The one ruled change (S2 E1, D5 PR2): an OK ENV value above its ceiling is lowered to it, source CEILING. */
function withE1Clamp(r: ResolvedCaps): ResolvedCaps {
  if (r.state !== "OK") return r;
  const op = Math.min(r.operatorUsd, PLATFORM_AI_OPERATOR_CAP_CEILING_USD);
  const pl = Math.min(r.platformUsd, PLATFORM_AI_PLATFORM_CAP_CEILING_USD);
  return { state: "OK", operatorUsd: op, platformUsd: pl, source: {
    operator: op !== r.operatorUsd ? "CEILING" : r.source.operator,
    platform: pl !== r.platformUsd ? "CEILING" : r.source.platform,
  } };
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
    // S2 E2 (D5 PR2): env is resolved FIRST; an INVALID env value refuses whatever a higher source says.
    check("E2: an INVALID env value refuses CAP_INVALID even when a setting would win (both caps)", (() => { const r = resolvePlatformAiCaps(input({ operatorRaw: "abc", platformRaw: "$5", settingPerOperatorUsd: 5, settingPlatformUsd: 9 })); return refused(r.operator, "CAP_INVALID") && refused(r.platform, "CAP_INVALID"); })());
    check("E2: an INVALID env value refuses even when an OVERRIDE would win", (() => { const r = resolvePlatformAiCaps(input({ operatorRaw: "5.", vercelEnv: "preview", operatorOverrideUsd: 3, settingPerOperatorUsd: 4 })); return refused(r.operator, "CAP_INVALID"); })());
    check("E2: …and the ResolvedCaps is REFUSE CAP_INVALID (operator first)", (() => { const r = toResolvedCaps(resolvePlatformAiCaps(input({ operatorRaw: "x", platformRaw: "y", operatorOverrideUsd: 3, settingPlatformUsd: 9 }))); return r.state === "REFUSE" && r.cause === "CAP_INVALID" && r.cap === "OPERATOR"; })());
    check("E2: an INVALID platform env refuses the platform cap only; a valid operator setting still resolves", (() => { const r = resolvePlatformAiCaps(input({ platformRaw: "1e3", settingPerOperatorUsd: 5, settingPlatformUsd: 9 })); return is(r.operator, 5, "PLATFORM_SETTING") && refused(r.platform, "CAP_INVALID"); })());
    check("E2: a MISSING env stays non-blocking when a higher source exists (production)", (() => { const r = resolvePlatformAiCaps(input({ operatorRaw: undefined, platformRaw: "", vercelEnv: "production", settingPerOperatorUsd: 5, settingPlatformUsd: 9 })); return is(r.operator, 5, "PLATFORM_SETTING") && is(r.platform, 9, "PLATFORM_SETTING"); })());
    check("an INVALID env value with no higher source still refuses CAP_INVALID", (() => { const r = resolvePlatformAiCaps(input({ operatorRaw: "5.", vercelEnv: "preview" })); return refused(r.operator, "CAP_INVALID"); })());
  }

  console.log("2. a present but invalid SETTING or OVERRIDE refuses CAP_INVALID (S2 R2; override D5 PR4, S2 09fq)");
  {
    const bad: unknown[] = [-1, 1.5, 0.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.5];
    for (const v of bad) {
      const op = resolvePlatformAiCaps(input({ operatorRaw: "7", platformRaw: "70", settingPerOperatorUsd: v as number }));
      check(`R2: per-operator setting ${String(v)} ⇒ CAP_INVALID for OPERATOR (env 7 does NOT rescue it); platform unaffected`,
        refused(op.operator, "CAP_INVALID") && is(op.platform, 70, "ENV") && (() => { const c = toResolvedCaps(op); return c.state === "REFUSE" && c.cause === "CAP_INVALID" && c.cap === "OPERATOR"; })(), op);
      const pl = resolvePlatformAiCaps(input({ operatorRaw: "7", platformRaw: "70", settingPlatformUsd: v as number }));
      check(`R2: platform setting ${String(v)} ⇒ CAP_INVALID for PLATFORM (env 70 does NOT rescue it); operator unaffected`,
        refused(pl.platform, "CAP_INVALID") && is(pl.operator, 7, "ENV") && (() => { const c = toResolvedCaps(pl); return c.state === "REFUSE" && c.cause === "CAP_INVALID" && c.cap === "PLATFORM"; })(), pl);
      // D5 PR4 (S2 09fq): a present invalid override refuses CAP_INVALID OPERATOR; platform unaffected.
      const ov = resolvePlatformAiCaps(input({ operatorRaw: "7", platformRaw: "70", operatorOverrideUsd: v as number }));
      check(`R2 override ${String(v)} ⇒ CAP_INVALID for OPERATOR (env 7 does NOT rescue it); platform unaffected`,
        refused(ov.operator, "CAP_INVALID") && is(ov.platform, 70, "ENV") && (() => { const c = toResolvedCaps(ov); return c.state === "REFUSE" && c.cause === "CAP_INVALID" && c.cap === "OPERATOR"; })(), ov);
    }
    const r = resolvePlatformAiCaps(input({ operatorRaw: "7", operatorOverrideUsd: 2.5, settingPerOperatorUsd: 4 }));
    check("D5 PR4: an invalid override does NOT fall through to a valid setting ⇒ CAP_INVALID", refused(r.operator, "CAP_INVALID"), r.operator);
    check("R2: an invalid setting refuses even when a valid override would win", (() => { const x = resolvePlatformAiCaps(input({ operatorRaw: "7", operatorOverrideUsd: 3, settingPerOperatorUsd: 2.5 })); return refused(x.operator, "CAP_INVALID"); })());
    const t = resolvePlatformAiCaps(input({ vercelEnv: "development", operatorOverrideUsd: -3, settingPerOperatorUsd: -3, settingPlatformUsd: 1.25 }));
    check("R2: invalid settings in development ⇒ CAP_INVALID (the test default does NOT rescue them)", refused(t.operator, "CAP_INVALID") && refused(t.platform, "CAP_INVALID"), t);
    const p = resolvePlatformAiCaps(input({ vercelEnv: "production", operatorOverrideUsd: -1, settingPerOperatorUsd: 2.5, settingPlatformUsd: Number.NaN }));
    check("R2: invalid settings in production ⇒ CAP_INVALID (not CAP_MISSING)", refused(p.operator, "CAP_INVALID") && refused(p.platform, "CAP_INVALID"), p);
    const absent = resolvePlatformAiCaps(input({ operatorRaw: "7", platformRaw: "70", settingPerOperatorUsd: null, settingPlatformUsd: null }));
    check("absent (null) settings are unchanged: not set ⇒ ENV", is(absent.operator, 7, "ENV") && is(absent.platform, 70, "ENV"), absent);
    const absentProd = resolvePlatformAiCaps(input({ vercelEnv: "production" }));
    check("absent settings + nothing else in production ⇒ CAP_MISSING (unchanged)", refused(absentProd.operator, "CAP_MISSING") && refused(absentProd.platform, "CAP_MISSING"), absentProd);
  }

  console.log("2b. D5 PR4: the override row parser (PlatformAiOperatorCap.dailyUsd, CHECK 0..20)");
  {
    check("no row ⇒ ABSENT ⇒ null (not set)", parseOperatorCapRow(null).state === "ABSENT" && capSettingUsdOf(parseOperatorCapRow(undefined)) === null);
    for (const v of [0, 1, 7, PLATFORM_AI_OPERATOR_CAP_CEILING_USD]) {
      const r = parseOperatorCapRow({ dailyUsd: v });
      check(`dailyUsd ${v} ⇒ SET ${v}`, r.state === "SET" && r.usd === v, r);
    }
    for (const v of [-1, 21, 500, 2.5, Number.NaN, "5", null, undefined, Number.POSITIVE_INFINITY]) {
      const r = parseOperatorCapRow({ dailyUsd: v });
      check(`dailyUsd ${JSON.stringify(v) ?? String(v)} ⇒ INVALID (not a whole number 0..20) ⇒ NaN ⇒ the resolver refuses CAP_INVALID OPERATOR`,
        r.state === "INVALID" && Number.isNaN(capSettingUsdOf(r)) && refused(resolvePlatformAiCaps(input({ operatorRaw: "7", platformRaw: "70", operatorOverrideUsd: capSettingUsdOf(r) })).operator, "CAP_INVALID"), r);
    }
    const zero = toResolvedCaps(resolvePlatformAiCaps(input({ operatorRaw: "7", platformRaw: "70", operatorOverrideUsd: capSettingUsdOf(parseOperatorCapRow({ dailyUsd: 0 })) })));
    check("override row 0 ⇒ operator cap 0 (that operator is off), source OPERATOR_OVERRIDE", zero.state === "OK" && zero.operatorUsd === 0 && zero.source.operator === "OPERATOR_OVERRIDE", zero);
    check("turns that fit: floor(cap / reserve); null on an unknown cap or reserve",
      platformAiTurnsThatFit(10, 3) === 3 && platformAiTurnsThatFit(0, 3) === 0 && platformAiTurnsThatFit(0.9, 0.3) === 3 && platformAiTurnsThatFit(null, 3) === null && platformAiTurnsThatFit(10, null) === null && platformAiTurnsThatFit(10, 0) === null);
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
    // S2 E1 (D5 PR2): ENV is clamped to the ceilings like every other source (no env var is set anywhere: a no-op in practice).
    const envHi = resolvePlatformAiCaps(input({ operatorRaw: "50", platformRaw: "250.75" }));
    check("E1: ENV above the ceiling is clamped (50 ⇒ 20, 250.75 ⇒ 100), source CEILING, askedSource ENV, clamped",
      is(envHi.operator, 20, "CEILING", { askedUsd: 50, clamped: true }) && envHi.operator.ok && envHi.operator.askedSource === "ENV"
      && is(envHi.platform, 100, "CEILING", { askedUsd: 250.75, clamped: true }) && envHi.platform.ok && envHi.platform.askedSource === "ENV", envHi);
    check("E1: ENV 999999.99 ⇒ the ceilings (20 / 100), clamped", (() => { const r = resolvePlatformAiCaps(input({ operatorRaw: "999999.99", platformRaw: "999999.99" })); return is(r.operator, 20, "CEILING", { askedUsd: 999999.99, clamped: true }) && is(r.platform, 100, "CEILING", { askedUsd: 999999.99, clamped: true }); })());
    check("E1: ENV exactly at the ceiling (20 / 100) ⇒ not clamped, source ENV", (() => { const r = resolvePlatformAiCaps(input({ operatorRaw: "20", platformRaw: "100" })); return is(r.operator, 20, "ENV") && is(r.platform, 100, "ENV"); })());
    check("E1: ENV 20.01 ⇒ 20 clamped (cents above the ceiling count)", (() => { const r = resolvePlatformAiCaps(input({ operatorRaw: "20.01" })); return is(r.operator, 20, "CEILING", { askedUsd: 20.01, clamped: true }); })());
    check("E1: the ResolvedCaps of a clamped env reports source CEILING", (() => { const r = resolvePlatformAiSpendCaps({ operatorRaw: "50", platformRaw: "40", vercelEnv: "production" }); return r.state === "OK" && r.operatorUsd === 20 && r.source.operator === "CEILING" && r.platformUsd === 40 && r.source.platform === "ENV"; })());
    check("ENV keeps its cents (12.50 ⇒ 12.5)", (() => { const r = resolvePlatformAiCaps(input({ operatorRaw: "12.50", platformRaw: "0.01" })); return is(r.operator, 12.5, "ENV") && is(r.platform, 0.01, "ENV"); })());
  }

  console.log("5. equivalence: env-only ≡ the PRE-D5 resolver, except the ruled E1 clamp");
  {
    const raws: (string | undefined)[] = [undefined, "", "0", "1", "10", "12.5", "12.50", "0.01", "20", "21", "100", "101", "999999.99", "1000000",
      " 5", "5.", "1e3", "-1", "$5", "five", "05", "5.123", "0x10", "Infinity", "NaN"];
    const envs: (string | undefined)[] = ["production", "preview", "development", undefined, "", "staging", "Preview", "PRODUCTION"];
    let cases = 0; const mismatches: unknown[] = [];
    for (const operatorRaw of raws) for (const platformRaw of raws) for (const vercelEnv of envs) {
      const i: CapInputs = { operatorRaw, platformRaw, vercelEnv };
      const want = JSON.stringify(withE1Clamp(legacyResolve(i)));
      const viaNew = JSON.stringify(toResolvedCaps(resolvePlatformAiCaps(envOnlyCapsInput(i))));
      const viaWrapper = JSON.stringify(resolvePlatformAiSpendCaps(i));
      cases++;
      if (viaNew !== want || viaWrapper !== want) mismatches.push({ i, want, viaNew, viaWrapper });
    }
    check(`${cases} env cases: new resolver (nulls) and the wrapper equal the PRE-D5 result with ONLY the E1 clamp applied`, mismatches.length === 0, mismatches.slice(0, 3));
    let changed = 0;
    for (const operatorRaw of raws) for (const platformRaw of raws) for (const vercelEnv of envs) {
      const i: CapInputs = { operatorRaw, platformRaw, vercelEnv };
      if (JSON.stringify(legacyResolve(i)) !== JSON.stringify(resolvePlatformAiSpendCaps(i))) {
        changed++;
        const l = legacyResolve(i);
        if (!(l.state === "OK" && (l.operatorUsd > PLATFORM_AI_OPERATOR_CAP_CEILING_USD || l.platformUsd > PLATFORM_AI_PLATFORM_CAP_CEILING_USD))) mismatches.push({ unexpectedChange: i });
      }
    }
    check(`every case that differs from PRE-D5 (${changed}) is an OK result with an ENV value above its ceiling`, changed > 0 && mismatches.length === 0, mismatches.slice(0, 3));
    check("envOnlyCapsInput passes null for override and both settings", (() => { const e = envOnlyCapsInput({ operatorRaw: "1", platformRaw: "2", vercelEnv: "production" }); return e.operatorOverrideUsd === null && e.settingPerOperatorUsd === null && e.settingPlatformUsd === null && e.operatorRaw === "1" && e.platformRaw === "2" && e.vercelEnv === "production"; })());
    const src = strip("lib/platform/ai/platform-ai-spend.ts");
    check("D5 PR2: the pre-transaction probe is env only and refuses ONLY on CAP_INVALID (a MISSING env waits for the settings)",
      /const envProbe = toResolvedCaps\(resolvePlatformAiCaps\(envOnlyCapsInput\(capInputs\)\)\);\s*if \(envProbe\.state === "REFUSE" && envProbe\.cause === "CAP_INVALID"\)/.test(src));
    check("D5 PR4: the in-transaction resolution passes the two settings and the operator's override row (parsed, R2)",
      /operatorOverrideUsd: capSettingUsdOf\(override\),\s*settingPerOperatorUsd: capSettingUsdOf\(perOperator\), settingPlatformUsd: capSettingUsdOf\(platform\),/.test(src)
      && /const override = parseOperatorCapRow\(overrideRow\);/.test(src));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}
main();
