/**
 * components/notifications/notification-icons.test.ts  (PERF-1)
 *
 * The notification bell resolves icons through an explicit, typed map — and
 * renders exactly what it rendered before.
 *
 * Before PERF-1 the bell resolved "triangle-alert" → icons["TriangleAlert"]
 * through lucide's `icons` object, which is every lucide icon: ~1,755 modules
 * in the client graph and ~1,755 again in SSR, on every shell page, because a
 * namespace-style lookup defeats Next's per-icon optimizePackageImports.
 *
 * §1 BEHAVIOUR — for every key the registry declares (and for "bell" and an
 *    unknown key), the new resolver returns the SAME component the old one
 *    did. That includes "file-warning", which the old map could not resolve
 *    and so rendered the Bell fallback; it still does, deliberately.
 * §2 STRUCTURE — no application file imports lucide's `icons` map, a
 *    namespace of lucide-react, or lucide's dynamic icon loader.
 *
 * (This test may import `icons`: tests are not bundled into any route.)
 *
 * Run:  npx tsx components/notifications/notification-icons.test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Bell, icons, type LucideIcon } from "lucide-react";
import { NOTIFICATION_REGISTRY } from "@/lib/notifications/registry";
import { NOTIFICATION_ICONS, iconFor } from "./NotificationBell";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** The pre-PERF-1 resolver, verbatim — the behaviour being preserved. */
function previousIconFor(key: string): LucideIcon {
  const pascal = key
    .split("-")
    .map((s) => (s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s))
    .join("");
  return (icons as Record<string, LucideIcon>)[pascal] ?? Bell;
}

console.log("1. every registry icon renders what it rendered before");
{
  const keys = [...new Set(Object.values(NOTIFICATION_REGISTRY).map((d) => d.icon as string))].sort();
  const changed = keys.filter((k) => iconFor(k) !== previousIconFor(k));
  check(`all ${keys.length} registry keys resolve to the same component as before`, changed.length === 0, changed.join(", "));
  check("'file-warning' still renders the Bell fallback (pre-existing; not a product decision here)",
    iconFor("file-warning") === Bell && previousIconFor("file-warning") === Bell);
  check("'bell' (a type that left the registry) renders Bell", iconFor("bell") === Bell);
  check("an unknown key renders Bell", iconFor("no-such-icon") === Bell);
  check("an inherited property name is not a key (the guard is own-property only)", iconFor("toString") === Bell);
  const unused = Object.keys(NOTIFICATION_ICONS).filter((k) => !keys.includes(k));
  check("the map carries no icon the registry does not use", unused.length === 0, unused.join(", "));
}

console.log("\n2. no application file imports the whole of lucide");
{
  const ROOT = process.cwd();
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "prototype") continue;
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(rel);
    }
  };
  for (const d of ["app", "components", "lib"]) walk(d);
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(path.join(ROOT, f), "utf8");
    for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']lucide-react["']/g)) {
      if (m[1]) continue;
      const names = m[2].split(",").map((n) => n.trim()).filter((n) => !n.startsWith("type "));
      if (names.some((n) => n.split(/\s+as\s+/)[0] === "icons")) offenders.push(`${f} (icons map)`);
    }
    if (/import\s+\*\s+as\s+\w+\s+from\s*["']lucide-react["']/.test(src)) offenders.push(`${f} (namespace import)`);
    if (/["']lucide-react\/dynamic["']|\bdynamicIconImports\b/.test(src)) offenders.push(`${f} (dynamic icon loader)`);
  }
  check(`no file under app/ components/ lib/ imports all of lucide (${files.length} scanned)`,
    offenders.length === 0, offenders.join("; "));
}

if (failures > 0) {
  console.error(`\nnotification-icons: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nnotification-icons: all checks passed");
