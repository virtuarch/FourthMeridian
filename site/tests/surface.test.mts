/**
 * PROOF 8 (and the authority surface around it) — the site exposes no API and
 * has no channel through which it could act for a visitor:
 *   - no route handlers, no /api, no middleware/proxy, no server actions;
 *   - a static export (no server runtime at all);
 *   - no network calls, no forms, no cookie / storage access in page code;
 *   - every absolute URL in the source is one of the declared origins;
 *   - the Vercel project file declares no crons, rewrites, functions or env.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { SITE_ROOT, appSourceFiles, parse, readJson, rel, visit, walk } from "./_source.mts";

const APP_DIR = path.join(SITE_ROOT, "app");
const appFiles = walk(APP_DIR).map(rel);

test("no route handlers, no /api tree, no middleware or proxy", () => {
  assert.deepEqual(appFiles.filter((f) => /(^|\/)route\.(ts|tsx|js|mjs)$/.test(f)), []);
  assert.deepEqual(appFiles.filter((f) => /^app\/api(\/|$)/.test(f)), []);
  assert.ok(!existsSync(path.join(APP_DIR, "api")));
  for (const f of ["middleware.ts", "middleware.js", "proxy.ts", "proxy.js", "pages"]) {
    assert.ok(!existsSync(path.join(SITE_ROOT, f)), `${f} must not exist`);
  }
});

test("the only metadata routes are robots, sitemap and the Open Graph image, all force-static", () => {
  // opengraph-image.tsx is a build-time PNG (next/og ImageResponse) emitted into
  // the static export; like the other two it declares dynamic = "force-static",
  // so there is still no server runtime behind any route.
  const metaRoutes = readdirSync(APP_DIR).filter((f) => /\.(ts|tsx)$/.test(f) && !/^(layout|page|not-found)\.tsx$/.test(f));
  assert.deepEqual(metaRoutes.sort(), ["opengraph-image.tsx", "robots.ts", "sitemap.ts"]);
  for (const f of metaRoutes) {
    let forceStatic = false;
    visit(parse(path.join(APP_DIR, f)), (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "dynamic" && n.initializer && ts.isStringLiteral(n.initializer)) {
        forceStatic = n.initializer.text === "force-static";
      }
    });
    assert.ok(forceStatic, `${f} must export dynamic = "force-static"`);
  }
});

test("page inventory equals SITE_ROUTES (the sitemap's source)", async () => {
  const { SITE_ROUTES } = await import("../lib/routes.ts");
  const pages = appFiles.filter((f) => f.endsWith("/page.tsx")).map((f) => {
    const dir = path.posix.dirname(f).replace(/^app/, "");
    return dir === "" ? "/" : dir;
  });
  assert.deepEqual(pages.sort(), [...SITE_ROUTES].sort());
});

test("static export is configured (no server runtime)", () => {
  let output: string | null = null;
  let unoptimized = false;
  visit(parse(path.join(SITE_ROOT, "next.config.ts")), (n) => {
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) {
      if (n.name.text === "output" && ts.isStringLiteral(n.initializer)) output = n.initializer.text;
      if (n.name.text === "unoptimized" && n.initializer.kind === ts.SyntaxKind.TrueKeyword) unoptimized = true;
    }
  });
  assert.equal(output, "export");
  assert.ok(unoptimized, "images.unoptimized: no image optimizer function");
});

test("page code has no server actions, network calls, forms, cookies or browser storage", () => {
  const NETWORK = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]);
  const STATE = new Set(["cookie", "cookieStore", "localStorage", "sessionStorage", "indexedDB", "sendBeacon"]);
  const problems: string[] = [];
  for (const file of appSourceFiles()) {
    const sf = parse(file);
    const at = (n: ts.Node) => `${rel(file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    visit(sf, (n) => {
      if (ts.isExpressionStatement(n) && ts.isStringLiteral(n.expression) && n.expression.text === "use server") problems.push(`${at(n)} "use server"`);
      if (ts.isIdentifier(n) && NETWORK.has(n.text)) problems.push(`${at(n)} ${n.text}`);
      if (ts.isIdentifier(n) && STATE.has(n.text)) problems.push(`${at(n)} ${n.text}`);
      if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && ts.isIdentifier(n.tagName) && n.tagName.text === "form") problems.push(`${at(n)} <form>`);
    });
  }
  assert.deepEqual(problems, []);
});

test("every absolute URL in the source is declared in lib/public-config.ts", () => {
  const problems: string[] = [];
  for (const file of appSourceFiles()) {
    if (rel(file) === "lib/public-config.ts") continue;
    const sf = parse(file);
    visit(sf, (n) => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n)) && /^(https?:)?\/\/[a-z0-9]/i.test(n.text)) {
        problems.push(`${rel(file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.text}`);
      }
      if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer) && /^(https?:)?\/\//i.test(n.initializer.text)) {
        problems.push(`${rel(file)} attribute ${n.initializer.text}`);
      }
    });
  }
  assert.deepEqual(problems, []);
});

test("vercel.json: headers only — no crons, rewrites, redirects, functions or env", () => {
  const v = readJson<Record<string, unknown>>("vercel.json");
  assert.deepEqual(Object.keys(v).sort(), ["$schema", "crons", "framework", "headers"]);
  assert.deepEqual(v.crons, []);
  const headers = (v.headers as { source: string; headers: { key: string; value: string }[] }[]).flatMap((h) => h.headers);
  const csp = headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
  for (const directive of ["default-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'none'", "object-src 'none'", "base-uri 'none'"]) {
    assert.ok(csp.includes(directive), `CSP must include ${directive}`);
  }
  assert.ok(headers.some((h) => h.key === "Strict-Transport-Security" && /includeSubDomains/.test(h.value)), "HSTS with includeSubDomains");
  assert.ok(headers.some((h) => h.key === "X-Frame-Options" && h.value === "DENY"));
});
