/**
 * PROOF 2 — the site's dependency graph carries no application authority.
 * Checked against the LOCKFILE (every installed package, direct and
 * transitive), not only package.json, so an authority-bearing package cannot
 * arrive as somebody else's dependency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./_source.mts";

interface Lock {
  name: string;
  lockfileVersion: number;
  packages: Record<string, { version?: string; resolved?: string; link?: boolean; dev?: boolean; optional?: boolean }>;
}
interface Pkg {
  name: string;
  private?: boolean;
  workspaces?: unknown;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
}

/**
 * Packages that confer, or exist only to use, application authority: database
 * clients, the session system, provider SDKs, secret-bearing services. The
 * public site must never install one, at any depth.
 */
const DENIED: readonly RegExp[] = [
  /^@prisma\//, /^prisma$/,                                  // database ORM
  /^next-auth$/, /^@auth\//, /^@next-auth\//,                // session authority
  /^plaid$/, /^react-plaid-link$/,                          // bank aggregation
  /^openai$/, /^@anthropic-ai\//, /^ai$/, /^@ai-sdk\//,      // model providers
  /^pg$/, /^postgres$/, /^@supabase\//, /^@neondatabase\//,  // database drivers
  /^@sentry\//,                                             // app telemetry (DSN, release authority)
  /^resend$/, /^@react-email\//,                            // outbound email
  /^bcrypt(js)?$/, /^otplib$/, /^jose$/,                    // credential / token primitives
  /^@vercel\/(kv|postgres|blob|edge-config)$/,              // platform data stores
];

const pkg = readJson<Pkg>("package.json");
const lock = readJson<Lock>("package-lock.json");

const installed = Object.entries(lock.packages)
  .filter(([key]) => key !== "")
  .map(([key, meta]) => ({ key, name: key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length), meta }));

test("site/package.json is its own private, non-workspace project", () => {
  assert.equal(pkg.name, "fourth-meridian-site");
  assert.equal(pkg.private, true);
  assert.equal(pkg.workspaces, undefined);
  assert.equal(lock.name, "fourth-meridian-site", "the lockfile belongs to site/, not the repository root");
});

test("direct dependencies are exactly the static site's runtime", () => {
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["next", "react", "react-dom", "react-markdown", "remark-gfm"]);
});

test("no denied package is installed at any depth", () => {
  const hits = installed.filter(({ name }) => DENIED.some((re) => re.test(name))).map(({ key }) => key);
  assert.deepEqual(hits, []);
});

test("every installed package comes from the registry — nothing is linked from the repository", () => {
  const local = installed.filter(({ meta }) => meta.link === true || (meta.resolved !== undefined && !meta.resolved.startsWith("https://registry.npmjs.org/")));
  assert.deepEqual(local.map(({ key, meta }) => `${key} → ${meta.resolved ?? "link"}`), []);
  for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.ok(!/^(file|link|workspace|portal):|^\.\.?\//.test(spec), `${name}@${spec} must come from the registry`);
  }
});

test("no script reaches outside site/", () => {
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    assert.ok(!/\.\.\//.test(cmd), `script "${name}" references a parent path: ${cmd}`);
  }
});
