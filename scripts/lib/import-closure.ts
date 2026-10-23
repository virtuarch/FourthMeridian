/**
 * scripts/lib/import-closure.ts — module reachability AS THE BUNDLER SEES IT.
 *
 * For dependency-boundary tests (PERF-1, PERF-3): which repository modules and
 * which npm packages does a module pull into a route's compilation?
 *
 * Edges are static imports, re-exports, dynamic import() and require() — a
 * dynamic import is free at Node module load but webpack still compiles its
 * target into the importing route, which is exactly how 34e592c put the whole
 * jobs tree (and the Plaid SDK) into every authenticated route. Type-only
 * imports/exports are NOT edges. Only `@/` and relative specifiers resolve to
 * repository files; everything else is reported as a package name.
 *
 * Pure apart from reading files under `root` — no module is executed.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Source with comments removed — string-aware, so "/api/*" inside a string survives. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const end = src.indexOf("*/", i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
    i++;
  }
  return out;
}

export interface Edges { local: string[]; packages: string[] }

export interface Closure {
  /** Every reachable repository file → the file that first reached it (null for a root). */
  via: Map<string, string | null>;
  /** Every reachable package → the first file that imported it. */
  packages: Map<string, string>;
}

export function importClosure(root: string = process.cwd()) {
  function resolveLocal(from: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith("@/")) base = spec.slice(2);
    else if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    else return null;
    for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
      if (/\.tsx?$/.test(base + ext) && existsSync(path.join(root, base + ext))) return base + ext;
    }
    return null;
  }

  /** Value edges of one file. */
  function edgesOf(file: string): Edges {
    const src = stripComments(readFileSync(path.join(root, file), "utf8"));
    const specs: string[] = [];
    for (const m of src.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?["']([^"']+)["']/g)) {
      if (!m[1]) specs.push(m[2]);
    }
    for (const m of src.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
    const local: string[] = [];
    const packages: string[] = [];
    for (const s of specs) {
      const resolved = resolveLocal(file, s);
      if (resolved) local.push(resolved);
      else if (!s.startsWith(".") && !s.startsWith("@/")) {
        packages.push(s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]);
      }
    }
    return { local, packages };
  }

  /** Transitive value closure of `roots`. */
  function closure(roots: string[]): Closure {
    const via = new Map<string, string | null>();
    const packages = new Map<string, string>();
    const todo: [string, string | null][] = roots.map((r) => [r, null]);
    while (todo.length > 0) {
      const [file, parent] = todo.pop()!;
      if (via.has(file)) continue;
      via.set(file, parent);
      const e = edgesOf(file);
      for (const p of e.packages) if (!packages.has(p)) packages.set(p, file);
      for (const l of e.local) todo.push([l, file]);
    }
    return { via, packages };
  }

  /** "a ← b ← root", for a failure message that names the path. */
  function chain(c: Closure, file: string): string {
    const out = [file];
    for (let p = c.via.get(file); p; p = c.via.get(p)) out.push(p);
    return out.join(" ← ");
  }

  return { edgesOf, closure, chain };
}
