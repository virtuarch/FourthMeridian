/**
 * lib/public-site-boundary.test.ts  (domain-split Stage B)
 *
 * The APPLICATION side of the public-site boundary. site/ (fourthmeridian.com)
 * is a separate Next project with zero authority; its own tests
 * (site/tests/*.test.mts, CI job `site`) prove it reaches nothing here. This
 * file proves the converse and the two deliberate copies between them:
 *
 *   1. The application's tooling never traverses site/: the TypeScript program,
 *      eslint, the Tailwind class scan and this repo's test discovery.
 *   2. No application module imports from site/, and the root package graph
 *      does not contain it (no workspace, no file: dependency).
 *   3. COPY PARITY. Until the app stops serving its own marketing pages
 *      (domain-split Stage F), the legal Markdown and the marketing copy exist
 *      in both trees and must be byte-identical — two published Terms of
 *      Service that differ would be a legal defect, not a style one.
 *   4. TOKEN PARITY. site/app/globals.css carries the subset of design tokens
 *      it uses; each must equal the application's declaration exactly.
 *
 * Deterministic, no runtime, no DB.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SITE = path.join(ROOT, "site");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

console.log("site/ exists and is its own project");
check("site/package.json, lockfile, tsconfig and next.config exist",
  ["site/package.json", "site/package-lock.json", "site/tsconfig.json", "site/next.config.ts"].every((f) => existsSync(path.join(ROOT, f))));

// ── 1. the application's tooling never traverses site/ ──────────────────────
console.log("the application's tooling never traverses site/");
{
  const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile).config, ts.sys, ROOT);
  const inSite = cfg.fileNames.filter((f) => path.resolve(f).startsWith(SITE + path.sep));
  check("root TypeScript program contains no file under site/", inSite.length === 0, `${inSite.length} file(s), e.g. ${inSite.slice(0, 3).join(", ")}`);
  check("root TypeScript program still sees the application", cfg.fileNames.some((f) => f.endsWith("/proxy.ts")));

  check("root eslint ignores site/**", /globalIgnores\(\[[\s\S]*?"site\/\*\*"[\s\S]*?\]\)/.test(read("eslint.config.mjs")));

  const css = read("app/globals.css");
  check('app/globals.css excludes site/ from the Tailwind class scan (@source not "../site")', /@source\s+not\s+"\.\.\/site"\s*;/.test(css));

  const runner = read("scripts/run-tests.ts");
  const roots = [...runner.matchAll(/collectTests\(path\.join\(ROOT,\s*"([^"]+)"\)\)/g)].map((m) => m[1]);
  check("test discovery has explicit roots", roots.length > 0, "no collectTests(path.join(ROOT, …)) roots found");
  check("test discovery never roots at site/", !roots.some((r) => r === "site" || r.startsWith("site/")), roots.join(", "));
}

// ── 2. no application module imports from site/; no package coupling ────────
console.log("the application does not depend on site/");
{
  const APP_ROOTS = ["app", "lib", "components", "context", "jobs", "scripts", "types", "prisma"];
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!["node_modules", "prototype", ".next"].includes(e.name)) walk(path.join(dir, e.name)); }
      else if (/\.(ts|tsx|mts|js|mjs)$/.test(e.name)) files.push(path.join(dir, e.name));
    }
  };
  APP_ROOTS.forEach((r) => walk(path.join(ROOT, r)));
  for (const f of ["proxy.ts", "next.config.ts", "instrumentation.ts", "instrumentation-client.ts"]) if (existsSync(path.join(ROOT, f))) files.push(path.join(ROOT, f));

  const offenders: string[] = [];
  for (const file of files) {
    if (file === __filename) continue;
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      let spec: string | null = null;
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) spec = n.moduleSpecifier.text;
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) spec = n.arguments[0].text;
      if (spec !== null) {
        const target = spec.startsWith("@/") ? path.join(ROOT, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(file), spec) : null;
        if (target !== null && (target === SITE || target.startsWith(SITE + path.sep))) offenders.push(`${path.relative(ROOT, file)} → ${spec}`);
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  check(`no application module imports from site/ (${files.length} files scanned)`, offenders.length === 0, offenders.join("; "));

  const pkg = JSON.parse(read("package.json"));
  check("root package.json declares no workspaces", pkg.workspaces === undefined);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
  check("root package.json depends on nothing in site/", !Object.values(deps).some((v) => /site/.test(v) && /^(file|link|workspace):/.test(v)));
  const lock = JSON.parse(read("package-lock.json"));
  check("root lockfile contains no site/ package", !Object.keys(lock.packages ?? {}).some((k) => k === "site" || k.startsWith("site/")));
}

// ── 3. copy parity (until Stage F retires the app's marketing pages) ────────
console.log("legal text and marketing copy are byte-identical in both trees");
for (const [appCopy, siteCopy] of [
  ["content/marketing/terms.md", "site/content/legal/terms.md"],
  ["content/marketing/privacy.md", "site/content/legal/privacy.md"],
  ["content/marketing/legal-ai.md", "site/content/legal/legal-ai.md"],
  ["content/marketing/copy.ts", "site/content/copy.ts"],
] as const) {
  check(`${siteCopy} === ${appCopy}`, existsSync(path.join(ROOT, siteCopy)) && read(siteCopy) === read(appCopy),
    "edit both together (or retire the app's copy at Stage F)");
}

// ── 4. design-token parity ──────────────────────────────────────────────────
console.log("site design tokens equal the application's");
{
  /** Custom properties declared in the first rule whose selector text matches. */
  function declarations(css: string, selector: RegExp): Map<string, string> {
    const out = new Map<string, string>();
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      // At-rule statements (`@import …;`) precede the first rule; the selector is what follows the last `;`.
      if (!selector.test(m[1].split(";").pop()!.trim())) continue;
      for (const d of m[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) if (!out.has(d[1])) out.set(d[1], d[2].trim().replace(/\s+/g, " "));
    }
    return out;
  }
  const appCss = read("app/globals.css");
  const app = new Map([
    ...declarations(appCss, /^:root$/),
    ...declarations(appCss, /^html,\s*html\[data-theme="dark"\]$/),
  ]);
  const site = declarations(read("site/app/globals.css"), /^:root$/);
  check("site declares tokens", site.size > 10, `${site.size}`);
  const drift = [...site].filter(([k, v]) => app.get(k) !== v).map(([k, v]) => `${k}: site "${v}" vs app "${app.get(k) ?? "(undeclared)"}"`);
  check(`every site token (${site.size}) equals the application's dark-theme declaration`, drift.length === 0, drift.join("; "));
}

if (failures > 0) {
  console.error(`\n${failures} public-site boundary check(s) failed.`);
  process.exit(1);
}
console.log("\nAll public-site boundary checks passed.");
