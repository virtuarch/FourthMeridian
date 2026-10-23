/**
 * lib/monitoring/sentry-dev-gate.test.ts  (PERF-4)
 *
 * `next dev` with no Sentry DSN must not compile the Sentry SDK; with a DSN, and
 * in every production/preview build, Sentry must be exactly what it was.
 *
 * Without a DSN the SDK was already `enabled: false` — it sent nothing — but the
 * dev server still compiled it: 954 module instances (the Node SDK and
 * OpenTelemetry) in the instrumentation layer and ~310 in every page's client
 * bundle. A runtime `if (!dsn)` cannot avoid that; the bundler compiles both
 * branches. next.config.ts therefore resolves `@sentry/nextjs` to
 * lib/monitoring/sentry-dev-stub.ts in exactly one case: development AND no DSN.
 * Measured (Node 24, dashboard-first session): server module instances
 * 2,665 → 1,682, client 1,038 → 729, boot heapUsed ~273 → ~109 MB. A
 * production build is byte-identical to the one before the gate (BUILD_ID and
 * the per-build action key aside), with and without a DSN.
 *
 * What is pinned here, and why each is derived rather than listed:
 *   1. The gate: the alias exists ONLY for development without a DSN. A DSN in
 *      dev, or any production build, sees no `webpack` key at all.
 *   2. The stub covers every binding the compiled code reads from
 *      `@sentry/nextjs` — found by scanning the importers, so a new
 *      `Sentry.something` in an init surface fails here instead of crashing
 *      `next dev` — and it reaches no module and no package.
 *
 * Run:  npx tsx lib/monitoring/sentry-dev-gate.test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { importClosure, stripComments } from "../../scripts/lib/import-closure";
import * as stub from "@/lib/monitoring/sentry-dev-stub";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const STUB = "lib/monitoring/sentry-dev-stub.ts";
const SDK = "@sentry/nextjs";
const env = process.env as Record<string, string | undefined>;

// ── 1. The gate: exactly development without a DSN ──────────────────────────
console.log("1. the SDK is replaced only in development without a DSN");
{
  type Cfg = { webpack?: (c: { resolve: { alias: Record<string, unknown> } }) => { resolve: { alias: Record<string, unknown> } } };
  const configPath = require.resolve(path.join(ROOT, "next.config.ts"));
  const saved = { NODE_ENV: env.NODE_ENV, DSN: env.NEXT_PUBLIC_SENTRY_DSN };
  const load = (nodeEnv: string, dsn: string | undefined): Cfg => {
    env.NODE_ENV = nodeEnv;
    if (dsn === undefined) delete env.NEXT_PUBLIC_SENTRY_DSN;
    else env.NEXT_PUBLIC_SENTRY_DSN = dsn;
    delete require.cache[configPath];
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-evaluated per environment
    return (require(configPath) as { default: Cfg }).default;
  };
  const DSN = "https://public@o0.ingest.sentry.io/0";
  try {
    const dev = load("development", undefined);
    check("development, no DSN: a webpack hook is installed", typeof dev.webpack === "function");
    const out = dev.webpack?.({ resolve: { alias: { keep: "me" } } });
    const alias = out?.resolve.alias ?? {};
    check(`…which resolves exactly "${SDK}" (and nothing else) to the stub`,
      alias[`${SDK}$`] === path.join(ROOT, STUB) && alias.keep === "me" && Object.keys(alias).length === 2,
      JSON.stringify(alias));
    check("development, empty DSN (the .env.example default) is still no DSN",
      typeof load("development", "").webpack === "function");
    check("development WITH a DSN: no webpack hook — the real SDK, as before",
      load("development", DSN).webpack === undefined);
    check("production build, no DSN (Preview): no webpack hook",
      load("production", undefined).webpack === undefined);
    check("production build WITH a DSN: no webpack hook",
      load("production", DSN).webpack === undefined);
  } finally {
    env.NODE_ENV = saved.NODE_ENV;
    if (saved.DSN === undefined) delete env.NEXT_PUBLIC_SENTRY_DSN;
    else env.NEXT_PUBLIC_SENTRY_DSN = saved.DSN;
    delete require.cache[configPath];
  }
}

// ── 2. The stub stands in for every binding the compiled code reads ─────────
console.log("\n2. the stub covers every binding read from the SDK entry, and reaches nothing");
{
  const graph = importClosure();
  const files: string[] = ["instrumentation.ts", "instrumentation-client.ts"];
  const walk = (dir: string) => {
    for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "prototype") continue;
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(rel);
    }
  };
  for (const d of ["app", "components", "lib"]) walk(d);
  const importers = files.filter((f) => graph.edgesOf(f).packages.includes(SDK));
  check("the init surfaces import the SDK entry (else the stub stands in for nothing)",
    importers.includes("instrumentation.ts") && importers.includes("instrumentation-client.ts"),
    importers.join(", "));

  const read = new Map<string, string>();
  for (const f of importers) {
    const src = stripComments(readFileSync(path.join(ROOT, f), "utf8"));
    for (const m of src.matchAll(new RegExp(`import\\s+\\*\\s+as\\s+(\\w+)\\s+from\\s*["']${SDK}["']`, "g"))) {
      for (const b of src.matchAll(new RegExp(`\\b${m[1]}\\.(\\w+)`, "g"))) read.set(b[1], f);
    }
    for (const m of src.matchAll(new RegExp(`import\\s+(?!type\\b)\\{([^}]*)\\}\\s*from\\s*["']${SDK}["']`, "g"))) {
      for (const part of m[1].split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
        if (name && !/^type\s/.test(part.trim())) read.set(name, f);
      }
    }
  }
  check("bindings read from the SDK entry were found", read.size > 0);
  const missing = [...read].filter(([b]) => !(b in stub));
  check(`the stub exports every one of them (${[...read.keys()].sort().join(", ")})`,
    missing.length === 0, missing.map(([b, f]) => `${b} (read in ${f})`).join(", "));
  check("init is callable and initialises nothing",
    typeof stub.init === "function" && stub.init({ dsn: "x" }) === undefined);
  check("the request-error and transition hooks are absent, so Next registers neither",
    stub.captureRequestError === undefined && stub.captureRouterTransitionStart === undefined);

  const e = graph.edgesOf(STUB);
  check("the stub imports no module and no package (it must not pull the SDK back in)",
    e.local.length === 0 && e.packages.length === 0, [...e.local, ...e.packages].join(", "));
}

if (failures > 0) {
  console.error(`\nsentry-dev-gate: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nsentry-dev-gate: all checks passed");
