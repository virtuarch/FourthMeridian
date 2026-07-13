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
      const allowed = ALLOWED_INTERNAL_PREFIXES.some(
        (p) => spec === p || spec.startsWith(p + "/"),
      );
      check(
        `${rel} internal import "${spec}" is within the marketing seam`,
        allowed,
        `only ${ALLOWED_INTERNAL_PREFIXES.join(", ")} are allowed`,
      );
    }
  }
}

// ── "use client" discipline: only the interactive islands opt in ─────────────
// The marketing tree stays server-only EXCEPT the two forms that genuinely need
// client interactivity: the beta-access form and its Turnstile CAPTCHA widget
// (Wave 2 ⑥ — a marketing-local copy so the tree carries no app-component
// dependency across the split seam). Any OTHER "use client" file is a
// regression that pulls needless client weight into pages meant to stay light.

const ALLOWED_CLIENT_FILES = [
  path.join("components", "marketing", "RequestAccessForm.tsx"),
  path.join("components", "marketing", "TurnstileWidget.tsx"),
];
const clientFiles = files.filter((rel) => {
  const raw = readFileSync(path.join(ROOT, rel), "utf8");
  return /^\s*["']use client["']/m.test(raw);
});
check(
  'the only "use client" files are the beta-access form + its CAPTCHA widget',
  clientFiles.every((f) => ALLOWED_CLIENT_FILES.includes(f)),
  `unexpected client file(s): ${clientFiles.filter((f) => !ALLOWED_CLIENT_FILES.includes(f)).join(", ") || "none"}`,
);

if (failures > 0) {
  console.error(`\n${failures} marketing-boundary check(s) failed.`);
  process.exit(1);
}
console.log("\nAll marketing-boundary checks passed.");
