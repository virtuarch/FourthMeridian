/**
 * components/ui/platform-context-switch.test.ts  (UX-P2 — navigation separation)
 *
 * Standalone tsx + renderToStaticMarkup (house pattern), exits 0/1.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/ui/platform-context-switch.test.ts
 *
 * The GlobalHeader's `[ Personal Spaces ] [ Platform Spaces ]` control, pinned
 * by rendering the real component and by scanning the load-bearing lines:
 *   A. hidden without a grant — nothing, not an empty track;
 *   B. two LINKS, to the launcher and the directory, nowhere else;
 *   C. the active segment is the route's context (lib/space-nav navContext);
 *   D. phone presentation — the inactive label collapses to its icon below sm,
 *      the accessible name survives;
 *   E. it is DISPLAY: no cookie, no storage, no fetch, no switch call, no
 *      prefetch; the flag is a server prop handed down layout → chrome → header.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PlatformContextSwitchView } from "@/components/ui/PlatformContextSwitch";
import { PRIMARY_NAV, PLATFORM_DIRECTORY_HREF, navContext, primaryHref } from "@/lib/space-nav";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (...p: string[]) => readFileSync(path.join(process.cwd(), ...p), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
/** The aria-label of every <a aria-current="page">. */
const current = (html: string) =>
  [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>/g)].map((m) => m[0].match(/aria-label="([^"]+)"/)?.[1] ?? "?");

const render = (hasPlatformGrants: boolean, pathname: string | null) =>
  renderToStaticMarkup(createElement(PlatformContextSwitchView, { hasPlatformGrants, pathname }));

// ─────────────────────────────────────────────────────────────────────────────
console.log("A. Hidden without a grant");
{
  for (const p of ["/dashboard", "/dashboard/spaces", "/dashboard/platform", "/dashboard/platform/PLATFORM_OPS", null]) {
    check(`no grant ⇒ renders NOTHING on ${p ?? "null"}`, render(false, p) === "", render(false, p));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("B. Two links, to the launcher and the directory");
{
  const html = render(true, "/dashboard/spaces");
  check("a grant ⇒ the control renders", html !== "");
  check('a <nav aria-label="Context">', html.includes('<nav aria-label="Context"'));
  check("exactly two links: the Spaces primary destination's route, then the directory",
    hrefs(html).join() === [primaryHref("spaces"), PLATFORM_DIRECTORY_HREF].join(), hrefs(html).join());
  check("the launcher href IS PRIMARY_NAV's Spaces href (not restated)", primaryHref("spaces") === PRIMARY_NAV.find((d) => d.id === "spaces")!.href);
  check("the directory is /dashboard/platform (decision N3)", PLATFORM_DIRECTORY_HREF === "/dashboard/platform");
  check("labels: Personal Spaces · Platform Spaces, as accessible names",
    /aria-label="Personal Spaces"/.test(html) && /aria-label="Platform Spaces"/.test(html));
  check("icons: Layers for Personal, Shield for Platform",
    html.includes("lucide-layers") && html.includes("lucide-shield") && html.indexOf("lucide-layers") < html.indexOf("lucide-shield"));
  check("no link to an AREA — the Platform segment opens the directory, never a Space",
    hrefs(html).every((h) => !/\/dashboard\/platform\/./.test(h)));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("C. The active segment is the route's context");
{
  const cases: Array<[string | null, string]> = [
    ["/dashboard/spaces", "Personal Spaces"],
    ["/dashboard/spaces/invites", "Personal Spaces"],
    ["/dashboard", "Personal Spaces"],
    ["/dashboard/brief", "Personal Spaces"],
    ["/dashboard/analyze", "Personal Spaces"],
    ["/dashboard/connections", "Personal Spaces"],
    ["/dashboard/settings/account", "Personal Spaces"],
    ["/dashboard/platform", "Platform Spaces"],
    ["/dashboard/platform/PLATFORM_OPS", "Platform Spaces"],
    ["/dashboard/platform/SECURITY_OPS", "Platform Spaces"],
    ["/dashboard/platformx", "Personal Spaces"],
    [null, "Personal Spaces"],
  ];
  for (const [p, expected] of cases) {
    const on = current(render(true, p));
    check(`${p ?? "null (pre-hydration)"} ⇒ ${expected}, and only it`, on.join() === expected, on.join());
    check(`…navContext agrees`, navContext(p) === (expected === "Platform Spaces" ? "platform" : "personal"));
  }
  check("exactly one aria-current at every route",
    cases.every(([p]) => (render(true, p).match(/aria-current="page"/g) ?? []).length === 1));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("D. Phone presentation — icon-only inactive segment below sm");
{
  const html = render(true, "/dashboard/platform");
  const links = [...html.matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
  const personal = links.find((l) => l.includes('aria-label="Personal Spaces"'))!;
  const platform = links.find((l) => l.includes('aria-label="Platform Spaces"'))!;
  check("the INACTIVE label is sr-only below sm and visible from sm (stays in the DOM)",
    /<span class="sr-only sm:not-sr-only">Personal Spaces<\/span>/.test(personal), personal);
  check("the ACTIVE label is always visible", /<span class="">Platform Spaces<\/span>/.test(platform), platform);
  check("every segment keeps an explicit accessible name (icon-only never nameless)",
    links.every((l) => /aria-label="(Personal|Platform) Spaces"/.test(l)));
  check("the icon is decorative (aria-hidden) — the label is the name",
    links.every((l) => /<span aria-hidden="true" class="inline-flex shrink-0"><svg/.test(l)));
  check("the active pill is the neutral white-glass recipe (no blue)",
    /background:rgba\(255,255,255,\.09\)/.test(platform) && !/meridian/.test(platform));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("E. Display only — no authority, no persistence, no fetch; a server prop");
{
  const sw = code(read("components", "ui", "PlatformContextSwitch.tsx"));
  check("no cookie read or write", !/document\.cookie|cookies\(|ACTIVE_SPACE_COOKIE/.test(sw));
  check("no storage", !/localStorage|sessionStorage|indexedDB/.test(sw));
  check("no fetch, no switch call", !/fetch\(|\/api\//.test(sw));
  check("no effect or state (pure over props + pathname)", !/useEffect|useState|useLayoutEffect/.test(sw));
  check("links, not buttons", !/<button/.test(sw) && /<Link/.test(sw));
  check("prefetch={false} on the segment link", (sw.match(/prefetch=\{false\}/g) ?? []).length === 1);
  check("the active rule is the shared navContext(pathname)", /navContext\(pathname\)/.test(sw));
  check("hrefs come from lib/space-nav — no route literal restated",
    /primaryHref\("spaces"\)/.test(sw) && /PLATFORM_DIRECTORY_HREF/.test(sw) && !/"\/dashboard\/spaces"|"\/dashboard\/platform"/.test(sw));
  check("renders nothing without a grant (an early return, not a hidden track)", /if \(!hasPlatformGrants\) return null;/.test(sw));

  const header = read("components", "ui", "GlobalHeader.tsx");
  check("GlobalHeader mounts the switch ONCE in its centre slot, fed by the prop",
    (header.match(/<PlatformContextSwitch\b/g) ?? []).length === 1 &&
      /<PlatformContextSwitch hasPlatformGrants=\{hasPlatformGrants\} \/>/.test(header));
  check("GlobalHeader geometry untouched (h-12, border-b)", /flex h-12 items-center/.test(header) && /border-b/.test(header));
  check("the header's flag defaults to false (every other mount unchanged)", /hasPlatformGrants = false/.test(header));

  const chrome = read("components", "ui", "DashboardChrome.tsx");
  check("DashboardChrome passes the flag through to the header (no fetch of its own)",
    /<GlobalHeader hasPlatformGrants=\{hasPlatformGrants\} \/>/.test(chrome) && !/fetch\(/.test(code(chrome)));

  const layout = read("app", "(shell)", "dashboard", "layout.tsx");
  check("the layout computes the flag server-side through the one read site (decision N2)",
    /hasActivePlatformGrants\(session\.user\.id\)/.test(layout) && /@\/lib\/platform\/directory\.server/.test(layout));

  const navbar = code(read("components", "ui", "ContextualNavbar.tsx"));
  check("the sidebar still has exactly ONE /api/spaces fetch (the header added none)",
    (navbar.match(/fetch\("\/api\/spaces"\)/g) ?? []).length === 1);
  check("PRIMARY_NAV is still exactly five — the context switch is not a sixth destination", PRIMARY_NAV.length === 5);
}

if (failures > 0) { console.error(`\nplatform-context-switch: ${failures} failure(s).`); process.exit(1); }
console.log("\nplatform-context-switch: all passed.");
