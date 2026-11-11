/**
 * lib/platform/intelligence/ai/engine/router.test.ts  (Platform AI P2 — per-pack flags + router stub, I-8 / D-8)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/engine/router.test.ts
 *
 * 1. strictPlatformAiPackFlag: ON only for master "true" AND pack "true" (unset / "1" / "TRUE" / " true" ⇒ OFF);
 * 2. lib/env.ts: one getter per future pack, each exactly that rule over its own variable (source
 *    scan) — and the live getters over a mixed environment;
 * 3. the existing packs' flags (metrics + navigation = PLATFORM_AI_ENABLED, memory = the memory flag)
 *    and the router stub (flag-ON packs; memory only with the turn's hooks).
 */

const PACKS = ["CUSTOMERS", "ONBOARDING", "CONNECTIONS", "INCIDENTS", "JOBS", "PROVIDERS", "AI_USAGE", "AUDIT_HISTORY", "POLICIES", "GROWTH", "MERCHANTS"] as const;
const MIXED: Record<(typeof PACKS)[number], string | undefined> = {
  CUSTOMERS: "true", ONBOARDING: "1", CONNECTIONS: "TRUE", INCIDENTS: " true", JOBS: undefined, PROVIDERS: "yes",
  AI_USAGE: "false", AUDIT_HISTORY: "on", POLICIES: "", GROWTH: "True", MERCHANTS: undefined,
};
process.env.PLATFORM_AI_ENABLED = "true";
for (const p of PACKS) { if (MIXED[p] === undefined) delete process.env[`PLATFORM_AI_PACK_${p}_ENABLED`]; else process.env[`PLATFORM_AI_PACK_${p}_ENABLED`] = MIXED[p]; }

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const camel = (p: string) => p.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join("");

async function main() {
  const { env, strictPlatformAiPackFlag } = await import("@/lib/env");
  const { platformAiPackEnabled, routePlatformAiPacks } = await import("./router");

  console.log("1. the strict rule");
  const values: (string | undefined)[] = [undefined, "", "1", "TRUE", "True", " true", "true ", "yes", "on", "false", "true"];
  for (const m of values) for (const v of values) {
    const want = m === "true" && v === "true";
    if (strictPlatformAiPackFlag(m, v) !== want) check(`master=${JSON.stringify(m)} pack=${JSON.stringify(v)}`, false);
  }
  check("ON only for master === \"true\" AND pack === \"true\" (121 combinations)", true);

  console.log("\n2. lib/env.ts getters");
  const envSrc = readFileSync(path.join(process.cwd(), "lib/env.ts"), "utf8");
  for (const p of PACKS) {
    const re = new RegExp(`get isPlatformAiPack${camel(p)}Enabled\\(\\) \\{ return strictPlatformAiPackFlag\\(_e\\.PLATFORM_AI_ENABLED, _e\\.PLATFORM_AI_PACK_${p}_ENABLED\\); \\}`);
    check(`isPlatformAiPack${camel(p)}Enabled = strict(master, PLATFORM_AI_PACK_${p}_ENABLED); the variable is read from process.env`,
      re.test(envSrc) && new RegExp(`PLATFORM_AI_PACK_${p}_ENABLED: process\\.env\\.PLATFORM_AI_PACK_${p}_ENABLED,`).test(envSrc));
  }
  const live = Object.fromEntries(PACKS.map((p) => [p, (env as unknown as Record<string, boolean>)[`isPlatformAiPack${camel(p)}Enabled`]]));
  check("live, master ON: only the pack set to exactly \"true\" is ON (\"1\", \"TRUE\", \" true\", \"True\", unset ⇒ OFF)",
    Object.entries(live).filter(([, v]) => v === true).map(([k]) => k).join() === "CUSTOMERS" && Object.values(live).every((v) => typeof v === "boolean"), live);
  check("no pack getter can be ON with the master flag OFF", !values.some((v) => strictPlatformAiPackFlag(undefined, v)) && !strictPlatformAiPackFlag("false", "true"));

  console.log("\n3. existing packs + the router stub");
  const fakeEnv = (master: boolean, memory: boolean) => ({ isPlatformAiEnabled: master, isPlatformAiMemoryEnabled: memory });
  check("metrics + navigation follow PLATFORM_AI_ENABLED (ON wherever Platform AI is ON — behaviour unchanged)",
    platformAiPackEnabled("metrics", fakeEnv(true, false)) && platformAiPackEnabled("navigation", fakeEnv(true, false))
    && !platformAiPackEnabled("metrics", fakeEnv(false, false)) && !platformAiPackEnabled("navigation", fakeEnv(false, true)));
  check("memory follows the existing memory flag (and the master)",
    platformAiPackEnabled("memory", fakeEnv(true, true)) && !platformAiPackEnabled("memory", fakeEnv(true, false)) && !platformAiPackEnabled("memory", fakeEnv(false, true)));
  check("an undeclared pack ⇒ OFF", !platformAiPackEnabled("customers" as never, fakeEnv(true, true)));
  check("router stub: memory only with the turn's memory hooks",
    routePlatformAiPacks({ memory: false }, fakeEnv(true, true)).join() === "metrics,navigation"
    && routePlatformAiPacks({ memory: true }, fakeEnv(true, true)).join() === "metrics,navigation,memory"
    && routePlatformAiPacks({ memory: true }, fakeEnv(true, false)).join() === "metrics,navigation"
    && routePlatformAiPacks({ memory: true }, fakeEnv(false, true)).length === 0);

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
