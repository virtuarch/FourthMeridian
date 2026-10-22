/**
 * components/ui/route-boundaries.test.ts  (UI-007)
 *
 * /dashboard has segment error + loading boundaries, so a render failure keeps
 * the chrome instead of falling through to the unstyled app/global-error.tsx.
 * Pinned:
 *   1. the three files exist where the App Router reads them; the error files are
 *      client components whose default export takes { error, reset }
 *   2. they render INSIDE the layout (no <html>/<body> of their own) and reuse
 *      the shared RouteErrorFallback / RouteLoadingSkeleton
 *   3. the fallback renders an alert with Try again (calls reset) + a way out,
 *      never `error.message`, and shows the digest as a support reference
 *   4. the skeleton is an aria-busy status region
 *
 *   npx tsx components/ui/route-boundaries.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { RouteErrorFallback, RouteLoadingSkeleton } from "./RouteErrorFallback";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const DASH_ERROR = "app/(shell)/dashboard/error.tsx";
const DASH_LOADING = "app/(shell)/dashboard/loading.tsx";
const AREA_ERROR = "app/(shell)/dashboard/platform/[area]/error.tsx";

console.log("1. The boundaries exist where the App Router reads them");
for (const f of [DASH_ERROR, DASH_LOADING, AREA_ERROR]) check(`${f} exists`, existsSync(path.join(ROOT, f)));
for (const f of [DASH_ERROR, AREA_ERROR]) {
  const s = read(f);
  check(`${f} is a client component`, s.trimStart().startsWith('"use client"'));
  check(`${f} default-exports a ({ error, reset }) boundary`, /export default function \w+\(\{\s*error,\s*reset,?\s*\}/.test(s));
}

console.log("2. They render inside the layout and reuse the shared fallback");
for (const f of [DASH_ERROR, DASH_LOADING, AREA_ERROR]) {
  const s = read(f);
  check(`${f} renders no <html>/<body> (the chrome stays)`, !/<html|<body/.test(s));
  check(`${f} uses components/ui/RouteErrorFallback`, s.includes('from "@/components/ui/RouteErrorFallback"'));
}
check("loading.tsx is a server file (no 'use client')", !read(DASH_LOADING).includes('"use client"'));
check("platform error returns to the directory", read(AREA_ERROR).includes('backHref="/dashboard/platform"'));

console.log("3. The fallback");
{
  let resets = 0;
  const err = Object.assign(new Error("SECRET internal detail: relation \"User\" does not exist"), { digest: "abc123" });
  const html = renderToStaticMarkup(createElement(RouteErrorFallback, { error: err, reset: () => { resets++; }, what: "this page" }));
  check("role=alert", html.includes('role="alert"'));
  check("names what failed", html.includes("Something went wrong loading this page"));
  check("never renders error.message", !html.includes("SECRET"));
  check("shows the digest as a support reference", html.includes("Reference: abc123"));
  check("Try again button", html.includes("Try again") && html.includes('type="button"'));
  check("a way out (link to My Space by default)", html.includes('href="/dashboard"') && html.includes("Go to My Space"));
  check("decorative icons are aria-hidden", (html.match(/aria-hidden="true"/g) ?? []).length >= 2);
  check("render does not call reset", resets === 0);
  const src = read("components/ui/RouteErrorFallback.tsx");
  check("Try again calls the boundary's reset", src.includes("onClick={() => reset()}"));
  check("reports through @sentry/core (not the SDK entry)", src.includes('from "@sentry/core"') && src.includes("Sentry.captureException(error)"));
}

console.log("4. The skeleton");
{
  const html = renderToStaticMarkup(createElement(RouteLoadingSkeleton));
  check("status region, aria-busy", html.includes('role="status"') && html.includes('aria-busy="true"'));
  check("has a screen-reader label", html.includes('class="sr-only">Loading…'));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll UI-007 checks passed.");
