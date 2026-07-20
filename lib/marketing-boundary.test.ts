/**
 * lib/marketing-boundary.test.ts  (Growth/Security Wave 1① — landing page)
 *
 * Standalone tsx script (house source-scan pattern of lib/platform-surface.test.ts
 * and lib/security-surface.test.ts). Reads the landing-page source as text and
 * asserts the architectural seam from the investigation §3 cannot silently
 * regress: the public landing page never reaches into the authenticated app's
 * client component library or any Prisma-touching module.
 *
 * That seam is what lets the whole marketing tree split into its own repo/deploy
 * later — it carries the static pages + one fetch URL (/api/access-request) and
 * NOTHING else: no Prisma client, no schema, no auth, no app business logic.
 *
 * Enforcement is an IMPORT ALLOWLIST. Files under the three marketing roots may
 * only import from:
 *   - bare packages (react, next/*, react-markdown, remark-gfm, node builtins…)
 *   - the marketing seam itself: @/components/marketing, @/content/marketing,
 *     @/lib/marketing
 * Any other "@/…" import — @/lib/db, @/lib/auth, @/components/ui, etc. — or a
 * direct @prisma/client import fails the scan.
 *
 * There is deliberately NO "shared primitives" bucket. A shared root that both
 * the app and the marketing tree import is exactly the thing that would make the
 * tree non-extractable: at split time it becomes a package to publish or a
 * directory to duplicate. Marketing primitives live in @/components/marketing
 * even when that means a marketing-local copy of something the app also has
 * (TurnstileWidget is precisely that, by decision — Wave 2 ⑥). If a future slice
 * wants a shared root, that is an architecture decision to make explicitly, not
 * something to reach for the first time a component looks duplicated.
 *
 * ── CLIENT ISLANDS (MARKETING-BOUNDARY-1) ────────────────────────────────────
 *
 * This guard used to also pin an enumerated ALLOWED_CLIENT_FILES list — exactly
 * two files were permitted to carry "use client". That list was wrong in both
 * directions and had gone stale: the marketing redesign (ac26081) added a mobile
 * nav menu and a scroll-reveal wrapper, both of which genuinely require browser
 * APIs and cannot be server components, and the guard sat red for weeks.
 *
 * A permanently-red guard is worse than no guard — it trains people to skim past
 * suite failures, which is how the next REAL violation gets through. So the rule
 * now asserts the invariant that actually protects the seam rather than a
 * hand-maintained file list:
 *
 *   1. Public ROUTES stay server components. Nothing under app/(public) may
 *      carry "use client". This is the property that keeps pages light and
 *      indexable; it is what the old rule was really trying to protect.
 *   2. lib/marketing stays pure server-side modules — never a client component.
 *   3. Client islands are ALLOWED, without ceremony, but only under
 *      components/marketing. Interactivity is a legitimate need on a landing
 *      page (a mobile menu, a form, an IntersectionObserver reveal); the tree
 *      does not become non-extractable because a component runs in the browser.
 *   4. Islands carry NO extra import privileges. They are bound by the same
 *      allowlist as every other marketing file — asserted explicitly below, so
 *      the guarantee is legible in the output rather than merely implied by the
 *      general scan.
 *
 * What makes the tree splittable is the DEPENDENCY DIRECTION, not the
 * server/client split. "use client" is a bundling directive; an import of
 * @/lib/db is an architectural coupling. This guard now polices the second and
 * is deliberately indifferent to the first — except where it would drag whole
 * routes into the browser (rule 1).
 *
 * Deterministic, no runtime, no DB.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Recursively collect *.ts / *.tsx under a repo-relative dir; [] if absent.
 *  (.test.ts files are excluded — this scans shipped source, not the guard.) */
function filesUnder(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const childRel = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(childRel));
    else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      out.push(childRel);
    }
  }
  return out;
}

/** Strip block + line comments so a boundary-documenting comment that names a
 *  forbidden module (this very file's header does) never trips the scan. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every module specifier imported (static `import`, `export … from`, and
 *  dynamic `import("…")`) by a source file. */
function importSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bimport\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g, // import x from "y"
    /\bimport\s*['"]([^'"]+)['"]/g, // import "y" (side-effect)
    /\bexport\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g, // export … from "y"
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import("y")
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) specs.push(m[1]);
  }
  return specs;
}

// ── Roots that make up the landing-page seam ──────────────────────────────────

const MARKETING_ROOTS = [
  "components/marketing",
  "app/(public)",
  "lib/marketing",
];

/** Allowlisted internal ("@/…") import prefixes — the marketing seam only. */
const ALLOWED_INTERNAL_PREFIXES = [
  "@/components/marketing",
  "@/content/marketing",
  "@/lib/marketing",
];

/** Hard-forbidden specifiers regardless of prefix (a compromised marketing
 *  deploy must not be able to read User rows — no Prisma client anywhere). */
const FORBIDDEN_SPECIFIERS = [
  "@prisma/client",
  "@/lib/db",
  "@/lib/prisma",
  "@/lib/auth",
];

/**
 * The seam predicate — ONE authority, used by both the general file scan and the
 * client-island scan below, so the two can never drift into disagreeing about
 * what "inside the seam" means. Bare package specifiers (react, next/link,
 * lucide-react, node builtins) are not internal imports and are not this
 * function's business; it answers only for "@/…".
 */
function isWithinSeam(spec: string): boolean {
  return ALLOWED_INTERNAL_PREFIXES.some((p) => spec === p || spec.startsWith(p + "/"));
}

const files = MARKETING_ROOTS.flatMap(filesUnder);

console.log(`Scanning ${files.length} marketing source file(s) across ${MARKETING_ROOTS.join(", ")}\n`);

check(
  "landing-page source files exist (guard is not scanning an empty tree)",
  files.length > 0,
  "no files found under the marketing roots",
);

for (const rel of files) {
  const code = stripComments(readFileSync(path.join(ROOT, rel), "utf8"));
  const specs = importSpecifiers(code);

  for (const spec of specs) {
    // 1. Never a Prisma / auth / db module, by any path.
    check(
      `${rel} does not import forbidden module "${spec}"`,
      !FORBIDDEN_SPECIFIERS.includes(spec),
      "marketing must never touch Prisma / auth / db",
    );

    // 2. Any internal "@/…" import must be inside the marketing seam allowlist.
    if (spec.startsWith("@/")) {
      check(
        `${rel} internal import "${spec}" is within the marketing seam`,
        isWithinSeam(spec),
        `only ${ALLOWED_INTERNAL_PREFIXES.join(", ")} are allowed`,
      );
    }
  }
}

// ── Client-island discipline (MARKETING-BOUNDARY-1) ──────────────────────────
// See the header for the full rationale. In short: client islands are allowed
// under components/marketing because interactivity is a real landing-page need
// and "use client" is a bundling directive, not an architectural coupling. What
// is NOT allowed is dragging a whole route into the browser, making a lib module
// client-side, or an island quietly claiming import privileges other marketing
// files don't have.

const CLIENT_DIRECTIVE = /^\s*["']use client["']/m;

// Detector sanity. Every rule below is of the form "no file in X is a client
// component", which passes trivially if the detector silently stops matching.
// These fixtures pin the detector itself against synthetic input, so the guard
// cannot go vacuum-green from a regex edit. They assert nothing about the repo,
// so they stay valid even if the marketing tree becomes fully server-rendered.
const DETECTOR_FIXTURES: [label: string, source: string, expected: boolean][] = [
  ["double-quoted directive",      '"use client";\nexport const a = 1;',            true],
  ["single-quoted directive",      "'use client'\nexport const a = 1;",             true],
  ["indented directive",           '  "use client";\n',                             true],
  ["directive after a comment",    '/** doc */\n"use client";\n',                   true],
  ["prose inside a block comment", '/**\n * the single "use client" island.\n */\n', false],
  ["prose inside a line comment",  '// note: "use client" lives in the form\n',      false],
  ["plain server module",          'import x from "y";\nexport const a = 1;\n',      false],
];
for (const [label, source, expected] of DETECTOR_FIXTURES) {
  check(
    `client-directive detector: ${label} → ${expected ? "island" : "server"}`,
    CLIENT_DIRECTIVE.test(stripComments(source)) === expected,
  );
}

// Comments are stripped first: several marketing files DOCUMENT the directive in
// prose (app/(public)/request-access/page.tsx names it in its header), and a raw
// scan would read that as a violation.
const clientFiles = files.filter((rel) =>
  CLIENT_DIRECTIVE.test(stripComments(readFileSync(path.join(ROOT, rel), "utf8"))),
);

const COMPONENTS_ROOT = path.join("components", "marketing");
const PUBLIC_ROOT     = path.join("app", "(public)");
const LIB_ROOT        = path.join("lib", "marketing");
const under = (rel: string, root: string) => rel === root || rel.startsWith(root + path.sep);

// Rule 1 — public ROUTES stay server components.
const clientRoutes = clientFiles.filter((f) => under(f, PUBLIC_ROOT));
check(
  "no public route is a client component (pages stay server-rendered)",
  clientRoutes.length === 0,
  `client route(s): ${clientRoutes.join(", ")} — move the interactive part into a components/marketing island and keep the page a server component`,
);

// Rule 2 — lib/marketing stays pure server-side modules.
const clientLib = clientFiles.filter((f) => under(f, LIB_ROOT));
check(
  "no lib/marketing module is a client component",
  clientLib.length === 0,
  `client module(s): ${clientLib.join(", ")}`,
);

// Rule 3 — islands are allowed, but only under components/marketing.
const strayIslands = clientFiles.filter((f) => !under(f, COMPONENTS_ROOT));
check(
  "every client island lives under components/marketing",
  strayIslands.length === 0,
  `island(s) outside the components root: ${strayIslands.join(", ")}`,
);

// Rule 4 — islands carry NO extra import privileges. The general scan above
// already covers every marketing file; re-asserting it per island makes the
// guarantee explicit in the output, which is the whole point of allowing them.
for (const rel of clientFiles) {
  const code  = stripComments(readFileSync(path.join(ROOT, rel), "utf8"));
  const specs = importSpecifiers(code);

  const escapes = specs.filter((s) => s.startsWith("@/") && !isWithinSeam(s));
  check(
    `client island ${rel} imports nothing outside the marketing seam`,
    escapes.length === 0,
    `escaping import(s): ${escapes.join(", ")}`,
  );

  const forbidden = specs.filter((s) => FORBIDDEN_SPECIFIERS.includes(s));
  check(
    `client island ${rel} touches no Prisma / auth / db module`,
    forbidden.length === 0,
    `forbidden import(s): ${forbidden.join(", ")}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} marketing-boundary check(s) failed.`);
  process.exit(1);
}
console.log("\nAll marketing-boundary checks passed.");
