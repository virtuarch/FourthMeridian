/**
 * Shared source model for the boundary tests: every first-party file in site/,
 * parsed with the TypeScript compiler (the same parser `tsc` and Next use), so
 * the tests reason about syntax — imports, property accesses, directives — and
 * not about text that merely looks like them.
 *
 * Scope is site/ and nothing above it: the walk starts at SITE_ROOT and never
 * follows `..`. Generated and vendored trees are excluded.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EXCLUDED_DIRS = new Set(["node_modules", ".next", "out", ".vercel"]);
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export function walk(dir: string = SITE_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) out.push(...walk(path.join(dir, entry.name)));
    } else {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

export const rel = (abs: string): string => path.relative(SITE_ROOT, abs).split(path.sep).join("/");

/** Every first-party code file (excluding the generated next-env.d.ts). */
export function sourceFiles(): string[] {
  return walk().filter((f) => SOURCE_EXT.test(f) && rel(f) !== "next-env.d.ts");
}

/** Application code: what Next compiles into the site (not tests or tooling). */
export function appSourceFiles(): string[] {
  return sourceFiles().filter((f) => !/^(tests|scripts)\//.test(rel(f)) && !/^eslint\.config\./.test(rel(f)));
}

export function cssFiles(): string[] {
  return walk().filter((f) => f.endsWith(".css"));
}

export function parse(file: string): ts.SourceFile {
  const kind = /\.tsx$|\.jsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
}

export function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  node.forEachChild((child) => visit(child, fn));
}

export interface ModuleReference {
  file: string;
  specifier: string;
  line: number;
}

/** Every module reference: import/export-from, dynamic import(), require(), import("x") types. */
export function moduleReferences(file: string): ModuleReference[] {
  const sf = parse(file);
  const refs: ModuleReference[] = [];
  const add = (lit: ts.Node) => {
    if (ts.isStringLiteralLike(lit)) {
      refs.push({ file, specifier: lit.text, line: sf.getLineAndCharacterOfPosition(lit.getStart()).line + 1 });
    } else {
      refs.push({ file, specifier: "<non-literal>", line: sf.getLineAndCharacterOfPosition(lit.getStart()).line + 1 });
    }
  };
  visit(sf, (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) add(n.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) add(n.moduleReference.expression);
    else if (ts.isCallExpression(n) && n.arguments.length > 0 &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) add(n.arguments[0]);
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) add(n.argument.literal);
  });
  return refs;
}

/** Bare package name of a specifier: "next/link" → "next", "@scope/a/b" → "@scope/a". */
export function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function readJson<T = unknown>(relPath: string): T {
  return JSON.parse(readFileSync(path.join(SITE_ROOT, relPath), "utf8")) as T;
}

export const isFile = (p: string): boolean => {
  try { return statSync(p).isFile(); } catch { return false; }
};
