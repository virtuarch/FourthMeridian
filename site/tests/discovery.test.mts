/**
 * PROOF 7 — the site's own tooling never traverses the financial application.
 * Type-checking, linting, testing and the Next build each have a root, and each
 * root is site/. (The converse — the application's tooling skipping site/ — is
 * proved at the repository root by lib/public-site-boundary.test.ts.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { SITE_ROOT, parse, readJson, visit } from "./_source.mts";

test("tsconfig.json: every include/exclude/path stays inside site/; no extends, references or rootDirs", () => {
  const cfg = readJson<{ include: string[]; exclude: string[]; extends?: string; references?: unknown; compilerOptions: Record<string, unknown> }>("tsconfig.json");
  assert.equal(cfg.extends, undefined);
  assert.equal(cfg.references, undefined);
  assert.equal(cfg.compilerOptions.rootDirs, undefined);
  assert.equal(cfg.compilerOptions.baseUrl, undefined);
  for (const p of [...cfg.include, ...cfg.exclude]) assert.ok(!p.includes(".."), `tsconfig pattern leaves site/: ${p}`);
  const paths = cfg.compilerOptions.paths as Record<string, string[]>;
  assert.deepEqual(Object.keys(paths), ["@site/*"], "one alias, distinct from the application's `@/`");
  for (const targets of Object.values(paths)) for (const t of targets) assert.ok(!t.includes(".."), t);
});

test("TypeScript's resolved program contains no file outside site/ except installed type packages", () => {
  const configPath = path.join(SITE_ROOT, "tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, SITE_ROOT);
  const outside = parsed.fileNames.filter((f) => !path.resolve(f).startsWith(SITE_ROOT + path.sep));
  assert.deepEqual(outside, []);
  assert.ok(parsed.fileNames.length > 10, "the program sees the site's sources");
});

test("next.config.ts pins the Turbopack and file-tracing roots to site/", () => {
  const props = new Map<string, string>();
  visit(parse(path.join(SITE_ROOT, "next.config.ts")), (n) => {
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) props.set(n.name.text, n.initializer.getText());
  });
  assert.equal(props.get("root"), "SITE_ROOT", "turbopack.root");
  assert.equal(props.get("outputFileTracingRoot"), "SITE_ROOT");
  const src = readFileSync(path.join(SITE_ROOT, "next.config.ts"), "utf8");
  assert.match(src, /const SITE_ROOT = path\.dirname\(fileURLToPath\(import\.meta\.url\)\);/);
});

test("eslint and the test runner are scoped to site/", () => {
  const eslint = readFileSync(path.join(SITE_ROOT, "eslint.config.mjs"), "utf8");
  assert.ok(!/\bfrom\s+["']\.\.\//.test(eslint) && !/import\(\s*["']\.\.\//.test(eslint), "eslint.config.mjs must not load a config from a parent path");
  const pkg = readJson<{ scripts: Record<string, string> }>("package.json");
  assert.equal(pkg.scripts.test, 'node --test "tests/*.test.mts"');
});
