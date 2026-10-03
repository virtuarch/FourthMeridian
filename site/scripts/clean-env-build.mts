/**
 * site/scripts/clean-env-build.mts — PROOFS 4 and 5: the public site builds in
 * an environment that contains NO application secret, and what it emits carries
 * no authority.
 *
 *   npm run build:clean-env
 *
 * 1. Runs `next build` in a child process whose environment is CONSTRUCTED, not
 *    inherited: PATH, HOME, telemetry off, and the two public origins. Nothing
 *    from the caller's shell (DATABASE_URL, NEXTAUTH_SECRET, PLAID_*, …) and no
 *    root .env file can reach it; Next reads env files only from site/, and
 *    tests/public-env.test.mts proves site/ has none but the public template.
 *    Origins default to unroutable `.invalid` placeholders (RFC 2606), so CI
 *    needs no configuration; an owner may pass real public origins.
 * 2. Audits the output:
 *    - every page in lib/routes.ts was emitted as static HTML, plus robots/sitemap;
 *    - no server function and no middleware exist;
 *    - no emitted file contains a secret-shaped string or an /api reference;
 *    - every absolute URL in the HTML is on the site or app origin;
 *    - Next did not infer a workspace root above site/.
 * 3. Prints the route inventory, output size and dependency counts.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_ROUTES } from "../lib/routes.ts";

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(SITE_ROOT, "out");
const NEXT_DIR = path.join(SITE_ROOT, ".next");

const siteOrigin = process.env.NEXT_PUBLIC_SITE_ORIGIN || "https://site.build-check.invalid";
const appOrigin = process.env.NEXT_PUBLIC_APP_ORIGIN || "https://app.build-check.invalid";

const childEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  NEXT_TELEMETRY_DISABLED: "1",
  NEXT_PUBLIC_SITE_ORIGIN: siteOrigin,
  NEXT_PUBLIC_APP_ORIGIN: appOrigin,
};

const failures: string[] = [];
const fail = (msg: string) => failures.push(msg);

console.log(`[clean-env-build] environment passed to next build: ${Object.keys(childEnv).join(", ")}`);
const build = spawnSync(path.join(SITE_ROOT, "node_modules", ".bin", "next"), ["build"], {
  // `next build` sets NODE_ENV itself; Next's ProcessEnv typing marks it required.
  cwd: SITE_ROOT, env: childEnv as unknown as NodeJS.ProcessEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
const log = `${build.stdout}${build.stderr}`;
process.stdout.write(log);
if (build.status !== 0) {
  console.error(`[clean-env-build] next build exited ${build.status}`);
  process.exit(1);
}
if (/inferred your workspace root|multiple lockfiles/i.test(log)) fail("Next inferred a workspace root outside site/");

// ── emitted pages ──────────────────────────────────────────────────────────
const htmlFor = (route: string) => path.join(OUT, route === "/" ? "index.html" : `${route.slice(1)}.html`);
for (const route of SITE_ROUTES) if (!existsSync(htmlFor(route))) fail(`missing static page for ${route}`);
for (const f of ["robots.txt", "sitemap.xml", "404.html"]) if (!existsSync(path.join(OUT, f))) fail(`missing ${f}`);

// ── no server runtime ──────────────────────────────────────────────────────
const fnConfig = JSON.parse(readFileSync(path.join(NEXT_DIR, "server", "functions-config-manifest.json"), "utf8"));
if (Object.keys(fnConfig.functions ?? {}).length > 0) fail(`server functions emitted: ${Object.keys(fnConfig.functions).join(", ")}`);
const mw = JSON.parse(readFileSync(path.join(NEXT_DIR, "server", "middleware-manifest.json"), "utf8"));
if (Object.keys(mw.middleware ?? {}).length > 0 || Object.keys(mw.functions ?? {}).length > 0) fail("middleware emitted");

// ── emitted content ────────────────────────────────────────────────────────
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
const all = files(OUT);
const text = all.filter((f) => /\.(html|txt|js|css|xml|json|map)$/.test(f));

const SECRET_SHAPES: [string, RegExp][] = [
  ["database URL", /postgres(ql)?:\/\//i],
  ["application secret name", /\b(DATABASE_URL|DIRECT_URL|NEXTAUTH_SECRET|NEXTAUTH_URL|ENCRYPTION_KEY|CRON_SECRET|PLAID_SECRET|PLAID_CLIENT_ID|OPENAI_API_KEY|RESEND_API_KEY|TURNSTILE_SECRET_KEY)\b/],
  ["provider key", /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/],
  ["session cookie name", /next-auth\.session-token/],
  ["application API path", /["'`(]\/api\//],
];
for (const f of text) {
  const body = readFileSync(f, "utf8");
  for (const [label, re] of SECRET_SHAPES) if (re.test(body)) fail(`${path.relative(OUT, f)} contains a ${label}`);
}

const allowedOrigins = new Set([siteOrigin, appOrigin]);
const IGNORED_URL = /^https?:\/\/(www\.w3\.org|www\.sitemaps\.org)\//;
for (const f of all.filter((x) => x.endsWith(".html"))) {
  const body = readFileSync(f, "utf8");
  for (const m of body.matchAll(/(?:href|src|content|action)="(https?:\/\/[^"]+)"/g)) {
    if (IGNORED_URL.test(m[1])) continue;
    if (!allowedOrigins.has(new URL(m[1]).origin)) fail(`${path.relative(OUT, f)} links to a foreign origin: ${m[1]}`);
  }
}

// ── report ─────────────────────────────────────────────────────────────────
const bytes = all.reduce((n, f) => n + statSync(f).size, 0);
const lock = JSON.parse(readFileSync(path.join(SITE_ROOT, "package-lock.json"), "utf8"));
const pkgs = Object.entries(lock.packages as Record<string, { dev?: boolean }>).filter(([k]) => k !== "");
console.log("\n[clean-env-build] routes:", SITE_ROUTES.join("  "));
console.log(`[clean-env-build] output: ${all.length} files, ${(bytes / 1024).toFixed(0)} KiB, static only`);
console.log(`[clean-env-build] packages: ${pkgs.filter(([, m]) => !m.dev).length} runtime (incl. transitive), ${pkgs.filter(([, m]) => m.dev).length} dev-only`);

if (failures.length > 0) {
  console.error(`\n[clean-env-build] FAILED (${failures.length}):\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("[clean-env-build] OK — built with no application secret; output carries no authority.");
