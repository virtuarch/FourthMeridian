/**
 * app/api/platform/mutating-route-limits.test.ts — S2 P8 #5
 *
 * EVERY PLATFORM MUTATION IS RATE-LIMITED PER OPERATOR. A census of every
 * POST / PUT / PATCH / DELETE handler under app/api/platform/**: each one must
 * call a per-operator limiter (the house `limitByUser` family, the default
 * `limitPlatformMutation`, a route-family helper that wraps `limitByUser`, or a
 * `rateLimit:` dependency of the content-route runner, which keys on the
 * operator's user id) — or appear on ALLOWLIST below with a reason.
 *
 * GET handlers are out of scope. An IP-only limiter does not count: an operator
 * is an authenticated user and is limited as one.
 *
 * Standalone tsx script. No DB, no network.
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/platform/mutating-route-limits.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = join(__dirname, "..", "..", "..");
const PLATFORM = join(ROOT, "app", "api", "platform");

/**
 * `<route file>#<METHOD>` → why this mutating handler has no per-operator limiter.
 * Empty today. A webhook (an unauthenticated provider caller) would belong here;
 * none lives under app/api/platform.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {};

/** Calls that limit per operator (user id), and the helpers proven below to wrap one. */
const PER_OPERATOR = /\b(limitByUser|limitByKey|checkKeyLimitStrict|limitPlatformMutation|limitPolicyGroupWrites)\s*\(|\brateLimit\s*:/;
const MUTATING = ["POST", "PUT", "PATCH", "DELETE"] as const;

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) routeFiles(full, out);
    else if (e.name === "route.ts") out.push(full);
  }
  return out;
}

/** Strip comments so a limiter named in a comment does not count. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function main() {
  const files = routeFiles(PLATFORM).sort();
  const handlers: { key: string; body: string }[] = [];
  const reexports: string[] = [];
  for (const full of files) {
    const rel = relative(ROOT, full);
    const src = code(readFileSync(full, "utf8"));
    const starts = [...src.matchAll(/export\s+(?:(?:async\s+)?function|const)\s+(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)\b/g)];
    starts.forEach((m, i) => {
      if (!(MUTATING as readonly string[]).includes(m[1])) return;
      handlers.push({ key: `${rel}#${m[1]}`, body: src.slice(m.index!, starts[i + 1]?.index ?? src.length) });
    });
    // `export { handler as POST }` would escape the per-handler scan — refuse it.
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const name of MUTATING) if (new RegExp(`\\bas\\s+${name}\\b`).test(m[1])) reexports.push(`${rel}#${name}`);
    }
  }

  console.log("1. the census");
  check("the census found the platform route tree", files.length > 50, String(files.length));
  check("…and a real population of mutating handlers", handlers.length > 40, String(handlers.length));
  check("no mutating handler is a re-export the scan cannot read", reexports.every((k) => k in ALLOWLIST), reexports.join(", "));

  const missing = handlers.filter((h) => !PER_OPERATOR.test(h.body) && !(h.key in ALLOWLIST)).map((h) => h.key);
  check(`every mutating platform handler calls a per-operator limiter (${handlers.length} handlers)`, missing.length === 0,
    `\n      ${missing.join("\n      ")}`);

  const ipOnly = handlers.filter((h) => /\b(limitByIp|limitGlobal|checkIpLimitStrict)\s*\(/.test(h.body) && !PER_OPERATOR.test(h.body)).map((h) => h.key);
  check("no mutating handler is limited by IP alone", ipOnly.length === 0, ipOnly.join(", "));

  const known = new Set(handlers.map((h) => h.key));
  const stale = Object.keys(ALLOWLIST).filter((k) => !known.has(k) && !reexports.includes(k));
  check("every allowlist entry names a live handler", stale.length === 0, stale.join(", "));
  check("every allowlist entry carries a reason", Object.values(ALLOWLIST).every((r) => r.trim().length >= 20));

  console.log("\n2. the default limiter keys by operator, conservatively");
  {
    const lib = code(readFileSync(join(ROOT, "lib/platform/mutation-rate-limit.ts"), "utf8"));
    check("limitPlatformMutation wraps limitByUser (keyed by user id, never IP)",
      /limitByUser\(operatorUserId,/.test(lib) && !/limitByIp|getClientIp/.test(lib));
    check("the default is 30 per 60 s", /limit:\s*30,\s*windowSec:\s*60/.test(lib));
    const uses = handlers.filter((h) => /limitPlatformMutation\(/.test(h.body));
    check("every limitPlatformMutation call passes the guard's user id",
      uses.every((h) => /limitPlatformMutation\(auth\.user\.id,\s*"[a-z0-9-]+"\)/.test(h.body)), uses.map((h) => h.key).join(", "));
    check("…and returns the limiter's own response (the house 429)",
      uses.every((h) => /const (\w+) = await limitPlatformMutation\([^)]*\);\s*if \(\1\) return \1;/.test(h.body)));
    check("…after the access guard", uses.every((h) => {
      const g = h.body.search(/requireFresh(Platform)?Access\(|requirePlatformAccess\(/);
      return g >= 0 && g < h.body.indexOf("limitPlatformMutation(");
    }));
    const helper = code(readFileSync(join(ROOT, "lib/platform/policies/policy-groups-http.ts"), "utf8"));
    check("limitPolicyGroupWrites is a per-operator limiter", /limitPolicyGroupWrites\(auth: Auth\)[^{]*\{\s*return limitByUser\(auth\.user\.id,/.test(helper));
    const runner = code(readFileSync(join(ROOT, "lib/notifications/content/http.ts"), "utf8"));
    check("the content runner's `rateLimit` dependency is keyed by the operator's user id",
      /await deps\.rateLimit\(auth\.user\.id\)/.test(runner));
  }

  console.log("\n3. the 429 shape is the limiter's");
  {
    const rl = code(readFileSync(join(ROOT, "lib/rate-limit.ts"), "utf8"));
    check("limitByUser keys `user:<name>:<userId>` through enforce()", /enforce\(`user:\$\{name\}:\$\{userId\}`, cfg\)/.test(rl));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
