/**
 * PROOF 1 — every import that originates in site/ resolves INSIDE site/ or to an
 * explicitly allowed, declared npm package. Nothing reaches the financial
 * application's tree, by any path or alias.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { SITE_ROOT, appSourceFiles, cssFiles, isFile, moduleReferences, packageName, readJson, rel, sourceFiles } from "./_source.mts";

/** Packages APPLICATION code may import. Each is declared in site/package.json. */
const APP_PACKAGES = new Set(["next", "react", "react-dom", "react-markdown", "remark-gfm"]);
/** Additional packages tests and tooling may import (dev dependencies). */
const TOOLING_PACKAGES = new Set(["typescript", "eslint", "eslint-config-next"]);
/** next/* entry points the static site may use. next/headers, next/server, next/cache… are server authority. */
const NEXT_ENTRYPOINTS = new Set(["next", "next/link", "next/image"]);

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const SITE_ALIAS = "@site/";
const RESOLVE_EXT = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".css", "/index.ts", "/index.tsx"];

function resolveInside(fromFile: string, spec: string): string | null {
  const base = spec.startsWith(SITE_ALIAS) ? path.join(SITE_ROOT, spec.slice(SITE_ALIAS.length)) : path.resolve(path.dirname(fromFile), spec);
  for (const ext of RESOLVE_EXT) if (isFile(base + ext)) return base + ext;
  return null;
}

const insideSite = (abs: string) => abs === SITE_ROOT || abs.startsWith(SITE_ROOT + path.sep);

const pkg = readJson<{ dependencies: Record<string, string>; devDependencies: Record<string, string> }>("package.json");

test("the scan sees the site's source (not an empty tree)", () => {
  const files = sourceFiles().map(rel);
  for (const expected of ["app/layout.tsx", "app/page.tsx", "lib/public-config.ts", "components/SiteNav.tsx", "next.config.ts"]) {
    assert.ok(files.includes(expected), `expected to scan ${expected}`);
  }
});

test("every module reference resolves inside site/ or to an allowed, declared package", () => {
  const appFiles = new Set(appSourceFiles());
  const problems: string[] = [];
  for (const file of sourceFiles()) {
    const allowed = appFiles.has(file) ? APP_PACKAGES : new Set([...APP_PACKAGES, ...TOOLING_PACKAGES]);
    for (const ref of moduleReferences(file)) {
      const where = `${rel(ref.file)}:${ref.line} "${ref.specifier}"`;
      const s = ref.specifier;
      if (s === "<non-literal>") { problems.push(`${where}: computed module specifier`); continue; }
      if (s.startsWith(".") || s.startsWith(SITE_ALIAS)) {
        const target = resolveInside(file, s);
        if (target === null) problems.push(`${where}: does not resolve to a file`);
        else if (!insideSite(target)) problems.push(`${where}: resolves OUTSIDE site/ (${target})`);
        continue;
      }
      if (s.startsWith("@/")) { problems.push(`${where}: "@/" is the financial application's alias`); continue; }
      if (path.isAbsolute(s)) { problems.push(`${where}: absolute path`); continue; }
      if (BUILTINS.has(s)) continue;
      const name = packageName(s);
      if (!allowed.has(name)) { problems.push(`${where}: package "${name}" is not on the allowlist`); continue; }
      if (!(name in pkg.dependencies) && !(name in pkg.devDependencies)) problems.push(`${where}: "${name}" is not declared in site/package.json`);
      if (name === "next" && appFiles.has(file) && !NEXT_ENTRYPOINTS.has(s)) {
        problems.push(`${where}: next entry point "${s}" is not allowed in a static zero-authority site`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("Node built-ins are confined to build-time modules (never shipped to a browser)", () => {
  const BUILD_TIME = new Set(["next.config.ts", "lib/legal-content.ts"]);
  const offenders = appSourceFiles()
    .filter((f) => !BUILD_TIME.has(rel(f)))
    .flatMap((f) => moduleReferences(f).filter((r) => BUILTINS.has(r.specifier)).map((r) => `${rel(f)}:${r.line} ${r.specifier}`));
  assert.deepEqual(offenders, []);
});

test("stylesheets load nothing from outside site/ (no @import, no url() leaving the tree)", () => {
  const problems: string[] = [];
  for (const file of cssFiles()) {
    const css = readFileSync(file, "utf8");
    for (const m of css.matchAll(/@import\s+([^;]+);/g)) problems.push(`${rel(file)}: @import ${m[1]}`);
    for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      const target = m[1];
      if (/^(data:|#)/.test(target)) continue;
      if (/^[a-z]+:\/\//i.test(target) || target.startsWith("//")) problems.push(`${rel(file)}: remote url(${target})`);
      else if (target.startsWith("/")) continue; // served from site/public
      else if (!insideSite(path.resolve(path.dirname(file), target))) problems.push(`${rel(file)}: url(${target}) leaves site/`);
    }
  }
  assert.deepEqual(problems, []);
});
