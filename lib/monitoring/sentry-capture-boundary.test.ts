/**
 * lib/monitoring/sentry-capture-boundary.test.ts  (PERF-2)
 *
 * Capturing an error must not compile the Sentry SDK into the route; and the
 * capture must still reach the client the SDK initialised.
 *
 * On the server, `@sentry/nextjs` resolves to its full Node SDK (OpenTelemetry,
 * auto-instrumentations, a JS parser for import-in-the-middle). Imported by
 * lib/monitoring/capture.ts — which lib/auth.ts and lib/session.ts import — it
 * compiled ~730 modules into the rsc layer of every authenticated route, and
 * ~730 more into SSR through app/global-error.tsx. Measured (isolated A/B,
 * Node 24, dashboard-first session): server module instances 4,226 → 2,882,
 * heapUsed max ~1,650 → ~1,350–1,400 MB, session CPU 62–76 s → 50 s.
 *
 * Capture call sites now import @sentry/core. That is only correct while BOTH
 * of these hold, so both are asserted here:
 *   · captureException is the SAME function object in @sentry/nextjs and
 *     @sentry/core (one installed copy — no wrapper is bypassed);
 *   · the versions are identical: Sentry's global carrier is keyed by SDK
 *     version, so a @sentry/core that drifted from @sentry/nextjs would
 *     capture into a carrier no client was ever bound to — silently.
 * The init surfaces (instrumentation.ts / instrumentation-client.ts) stay on
 * @sentry/nextjs, so monitoring itself cannot quietly disappear either.
 *
 * Run:  npx tsx lib/monitoring/sentry-capture-boundary.test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as SentryCore from "@sentry/core";
import * as SentryNext from "@sentry/nextjs";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const pkgVersion = (name: string) =>
  (JSON.parse(read(`node_modules/${name}/package.json`)) as { version: string }).version;

console.log("1. a capture through @sentry/core is the SDK's capture");
{
  check("captureException is the same function in @sentry/nextjs and @sentry/core",
    SentryNext.captureException === SentryCore.captureException);
  const next = pkgVersion("@sentry/nextjs");
  const core = pkgVersion("@sentry/core");
  check("installed @sentry/core version equals @sentry/nextjs (the carrier is version-keyed)",
    core === next, `core ${core} vs nextjs ${next}`);
  const declared = (JSON.parse(read("package.json")) as { dependencies: Record<string, string> }).dependencies["@sentry/core"];
  check("package.json pins @sentry/core EXACTLY to that version (a caret range resolves ahead of the SDK)",
    declared === next, `declared ${declared}`);
}

console.log("\n2. only the init surfaces import the SDK entry");
{
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "prototype") continue;
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(rel);
    }
  };
  for (const d of ["app", "components", "lib"]) walk(d);
  const valueImport = /\b(?:import|export)\s+(?!type\b)[^;]*?from\s*["']@sentry\/nextjs["']|\b(?:import|require)\s*\(\s*["']@sentry\/nextjs["']\s*\)|^\s*import\s+["']@sentry\/nextjs["']/m;
  const offenders = files.filter((f) => valueImport.test(read(f)));
  check(`no file under app/ components/ lib/ value-imports @sentry/nextjs (${files.length} scanned)`,
    offenders.length === 0, offenders.join(", "));
  check("the boundary is live: lib/monitoring/capture.ts captures through @sentry/core",
    /from\s*["']@sentry\/core["']/.test(read("lib/monitoring/capture.ts")));

  const server = read("instrumentation.ts");
  check("instrumentation.ts still initialises the SDK and hooks request errors",
    /from\s*["']@sentry\/nextjs["']/.test(server) && /Sentry\.init\(/.test(server) &&
    /onRequestError\s*=\s*Sentry\.captureRequestError/.test(server));
  const client = read("instrumentation-client.ts");
  check("instrumentation-client.ts still initialises the browser SDK",
    /from\s*["']@sentry\/nextjs["']/.test(client) && /Sentry\.init\(/.test(client));
}

if (failures > 0) {
  console.error(`\nsentry-capture-boundary: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nsentry-capture-boundary: all checks passed");
