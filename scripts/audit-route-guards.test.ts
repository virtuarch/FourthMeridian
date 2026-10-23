/**
 * scripts/audit-route-guards.test.ts — proves the TEST-002 census discriminates.
 *
 * Builds a throwaway app/api tree in a temp dir and asserts: an unguarded route
 * FAILS; each recogniser PASSES; a guard mentioned only in a comment does not
 * count; a two-method route with one unguarded method is a finding; a one-hop
 * delegated guard is credited; `// PUBLIC:` needs a reason; and the allowlist
 * is exact in both directions. Then runs the real census on this checkout and
 * asserts it holds (the gate's own precondition).
 *
 * Hermetic: temp dir only, spawns nothing.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditRouteGuards, exportedMethods, stripComments } from "./lib/route-guards";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const root = mkdtempSync(join(tmpdir(), "fm-route-guards-"));
function route(rel: string, body: string): void {
  const file = join(root, "app", "api", rel, "route.ts");
  mkdirSync(join(root, "app", "api", rel), { recursive: true });
  writeFileSync(file, body);
}
function sibling(rel: string, name: string, body: string): void {
  writeFileSync(join(root, "app", "api", rel, name), body);
}
const run = (publicRoutes: Record<string, string> = {}) => auditRouteGuards(root, publicRoutes);
const reset = () => { rmSync(join(root, "app"), { recursive: true, force: true }); };

try {
  console.log("an unguarded handler is a finding");
  {
    reset();
    route("open", `import { NextResponse } from "next/server";\nexport async function GET() { return NextResponse.json({ ok: true }); }\n`);
    const r = run();
    check("1 route, 1 method, 0 guarded, 1 finding", r.routes === 1 && r.methods === 1 && r.guarded === 0 && r.findings.length === 1, JSON.stringify(r));
    check("the finding names the file and method", r.findings[0]?.file === "app/api/open/route.ts" && r.findings[0]?.method === "GET");
  }

  console.log("each recogniser satisfies the census");
  {
    const cases: Array<[string, string]> = [
      ["requireUser", `export async function GET() { const [u, err] = await requireUser(); if (err) return err; return ok(u); }`],
      ["requireFreshSystemAdmin", `export const POST = withApiHandler(async (req) => { const [a, e] = await requireFreshSystemAdmin(); return a; });`],
      ["requireSpaceRole", `export async function PATCH(req, { params }) { await requireSpaceRole(params.id, "EDITOR"); }`],
      ["requirePlatformAccess", `export async function DELETE() { const g = await requirePlatformAccess("GROWTH"); }`],
      ["cron bearer", `export const GET = withApiHandler(async (req) => { const s = process.env.CRON_SECRET; if (req.headers.get("authorization") !== \`Bearer \${s}\`) return deny(); });`],
      ["plaid webhook verifier", `export async function POST(req) { const v = await verifyPlaidWebhook(req, body); return handle(v); }`],
      ["nextauth handler", `const handler = NextAuth(authOptions);\nexport { handler as GET, handler as POST };`],
    ];
    for (const [name, body] of cases) {
      reset();
      route("r", body + "\n");
      const r = run();
      check(`${name}: guarded, no findings`, r.findings.length === 0 && r.guarded >= 1, JSON.stringify(r.findings));
    }
  }

  console.log("a guard named only in a comment does not count");
  {
    reset();
    route("c", `// requireUser() is called by the client before this\n/* requireSystemAdmin( */\nexport async function GET() { return ok(); }\n`);
    const r = run();
    check("comment-only mention ⇒ finding", r.findings.length === 1);
    check("stripComments removes both comment forms", !/require/.test(stripComments(`// requireUser(\n/* requireSystemAdmin( */ x`)));
  }

  console.log("per-method: one guarded and one unguarded method in the same file");
  {
    reset();
    route("m", `export async function GET() { const [u] = await requireUser(); return u; }\nexport async function POST() { return mutate(); }\n`);
    const r = run();
    check("2 methods, 1 guarded, 1 finding (POST)", r.methods === 2 && r.guarded === 1 && r.findings.length === 1 && r.findings[0].method === "POST", JSON.stringify(r.findings));
    check("exportedMethods lists both", exportedMethods(stripComments(`export async function GET(){}\nexport const POST = f;\nexport { h as PUT }`)).map((m) => m.method).join() === "GET,POST,PUT");
  }

  console.log("a local helper that carries the guard is credited");
  {
    reset();
    route("h", `async function authed(req) { const [u, e] = await requireUser(); if (e) return e; return u; }\nexport async function GET(req) { const u = await authed(req); return ok(u); }\n`);
    const r = run();
    check("helper-guarded method passes", r.findings.length === 0 && r.guarded === 1, JSON.stringify(r.findings));
  }

  console.log("a one-hop delegated guard (the seam pattern) is credited; two hops are not");
  {
    reset();
    route("d", `import { list } from "./handlers";\nimport { deps } from "./deps";\nexport async function GET(req) { return list(req, deps); }\n`);
    sibling("d", "handlers.ts", `export async function list(req, deps) { const [u, e] = await deps.requireUser(); return u; }\n`);
    sibling("d", "deps.ts", `import { requireUser } from "@/lib/session";\nexport const deps = { requireUser: () => requireUser() };\n`);
    check("one hop (deps.ts names requireUser) ⇒ guarded", run().findings.length === 0);
    reset();
    route("d2", `import { list } from "./handlers";\nexport async function GET(req) { return list(req); }\n`);
    sibling("d2", "handlers.ts", `import { authorize } from "./deps";\nexport async function list(req) { const u = await authorize(); return u; }\n`);
    sibling("d2", "deps.ts", `import { requireUser } from "@/lib/session";\nexport const deps = { requireUser: () => requireUser() };\n`);
    check("two hops ⇒ NOT credited (finding)", run().findings.length === 1);
  }

  console.log("// PUBLIC: needs a reason");
  {
    reset();
    route("p1", `// PUBLIC: unauthenticated uptime probe, rate-limited per IP\nexport async function GET() { return ok(); }\n`);
    check("annotation with a reason ⇒ public, no finding", (() => { const r = run(); return r.findings.length === 0 && r.publicByAnnotation.length === 1; })());
    reset();
    route("p2", `// PUBLIC: yes\nexport async function GET() { return ok(); }\n`);
    check("annotation with a 3-character reason ⇒ still a finding", run().findings.length === 1);
    reset();
    route("p3", `export async function GET() { /* PUBLIC: this is inside code and fine */ return ok(); }\n`);
    check("the annotation must be its own comment line", run().findings.length === 1);
  }

  console.log("the allowlist is exact");
  {
    reset();
    route("a", `export async function POST() { return intake(); }\n`);
    const list = { "app/api/a/route.ts": "intake before an account exists" };
    check("listed + unguarded ⇒ public by allowlist, no finding", (() => { const r = run(list); return r.findings.length === 0 && r.publicByAllowlist.length === 1 && r.allowlistErrors.length === 0; })());
    check("listed but missing on disk ⇒ allowlist error", run({ ...list, "app/api/gone/route.ts": "x" }).allowlistErrors.length === 1);
    reset();
    route("a", `export async function POST() { const [u] = await requireUser(); return u; }\n`);
    check("listed but now guarded ⇒ allowlist error (shrink the list)", run(list).allowlistErrors.some((e) => /now calls a guard/.test(e)));
    reset();
    route("a", `// PUBLIC: intake before an account exists, rate-limited\nexport async function POST() { return intake(); }\n`);
    check("listed AND annotated ⇒ allowlist error (one authority)", run(list).allowlistErrors.some((e) => /also carries/.test(e)));
  }

  console.log("the real census holds on this checkout");
  {
    const r = auditRouteGuards(process.cwd());
    check("no findings, no allowlist errors", r.findings.length === 0 && r.allowlistErrors.length === 0,
      JSON.stringify({ findings: r.findings.slice(0, 3), allowlistErrors: r.allowlistErrors }));
    check("every route has at least one exported method or is public", r.routes > 0 && r.methods >= r.routes - r.publicByAllowlist.length - r.publicByAnnotation.length);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
