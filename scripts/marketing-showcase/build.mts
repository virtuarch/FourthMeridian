/**
 * scripts/marketing-showcase/build.mts — bundles the capture harness.
 *
 *   node scripts/marketing-showcase/build.mts      (Node 24, repo root)
 *
 * esbuild bundles scenes.tsx for the browser (the app's tsconfig paths resolve
 * `@/`), and Tailwind compiles the app's own app/globals.css, so the scenes are
 * styled by exactly the stylesheet the product ships. Output: tmp/marketing-showcase/.
 */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "tmp", "marketing-showcase");
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: [path.join(ROOT, "scripts/marketing-showcase/scenes.tsx")],
  bundle: true,
  outfile: path.join(OUT, "scenes.js"),
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  minify: true,
  tsconfig: path.join(ROOT, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
  // Some shared modules read process.env.* (NEXT_PUBLIC_* flags); in the
  // harness every such flag is simply unset, as in a default build.
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "production" } };' },
  logLevel: "warning",
  loader: { ".css": "empty" },
});

const cssIn = path.join(ROOT, "app/globals.css");
const css = await postcss([tailwind({ base: ROOT })]).process(readFileSync(cssIn, "utf8"), { from: cssIn });
writeFileSync(path.join(OUT, "app.css"), css.css);

writeFileSync(path.join(OUT, "index.html"), `<!doctype html>
<html lang="en" data-theme="dark" class="h-full">
<head><meta charset="utf-8"><link rel="stylesheet" href="app.css">
<style>body{margin:0;background:var(--bg-base)} *{caret-color:transparent}</style></head>
<body class="min-h-full"><div id="root"></div><script type="module" src="scenes.js"></script></body></html>`);
console.log(`[showcase] built ${OUT}`);
