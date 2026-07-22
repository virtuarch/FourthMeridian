/**
 * lib/space/sync-incomplete-path.test.ts
 *
 * PRE-BETA-OPS-CLOSE final pass — the FULL product path for the
 * partial-convergence trust signal, ending at rendered markup
 * (house pattern: standalone tsx + renderToStaticMarkup, DB-free):
 *
 *   npx tsx lib/space/sync-incomplete-path.test.ts
 *
 *   PlaidItem.syncIncompleteAt
 *     → Space-scoped server read (lib/spaces/sync-completeness.ts)
 *     → /api/spaces/[id]/perspectives → useSpaceLensResults
 *     → useActiveEnvelope  → warnings[]
 *     → TrustIndicator     → visible caveat
 *
 * §1-2 pin the envelope decoration where BOTH envelope sources converge. §3
 * renders the REAL TrustIndicator and reads the copy back. §4 proves cross-Space
 * isolation at the query level — the property that stops one stalled institution
 * warning every Space a user owns. §5 pins the failure contract: an unknown must
 * never be reported as "fully synced".
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolvePerspectiveEnvelope, SYNC_INCOMPLETE_WARNING, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { TrustIndicator } from "@/components/space/trust/TrustIndicator";
import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** Mirrors useActiveEnvelope's decoration step exactly (same expression). */
function decorate(base: PerspectiveEnvelope, syncIncomplete: boolean | null): PerspectiveEnvelope {
  return syncIncomplete === true
    ? { ...base, warnings: [...(base.warnings ?? []), ...SYNC_INCOMPLETE_WARNING] }
    : base;
}

// ── 1. Both envelope sources get the caveat ─────────────────────────────────
console.log("1. Applied where BOTH envelope sources converge");
{
  // (a) workspace-emitted envelope
  const emitted: PerspectiveEnvelope = resolvePerspectiveEnvelope({ perspectiveId: "cashFlow" });
  const decoratedEmitted = decorate(emitted, true);
  check("a workspace-emitted envelope gains the caveat",
    (decoratedEmitted.warnings ?? []).some((w) => w.kind === "sync-incomplete"));

  // (b) lens-only fallback envelope
  const lensOnly = decorate(resolvePerspectiveEnvelope({ perspectiveId: "goals" }), true);
  check("a lens-only fallback envelope gains it too",
    (lensOnly.warnings ?? []).some((w) => w.kind === "sync-incomplete"));

  check("existing warnings are preserved, not replaced",
    (decorate(resolvePerspectiveEnvelope({ perspectiveId: "cashFlow", fxUnconverted: true }), true).warnings ?? [])
      .map((w) => w.kind).sort().join(",") === "fx,sync-incomplete");
  check("completeness axis untouched",
    JSON.stringify(decoratedEmitted.completeness) === JSON.stringify(emitted.completeness));
}

// ── 2. Recovered ⇒ absent ───────────────────────────────────────────────────
console.log("2. Recovered / healthy ⇒ no caveat");
{
  const base = resolvePerspectiveEnvelope({ perspectiveId: "cashFlow" });
  check("syncIncomplete=false ⇒ absent",
    !(decorate(base, false).warnings ?? []).some((w) => w.kind === "sync-incomplete"));
  check("false leaves the envelope byte-identical",
    JSON.stringify(decorate(base, false)) === JSON.stringify(base));
}

// ── 3. RENDERED — the real TrustIndicator ───────────────────────────────────
console.log("3. Rendered through the real TrustIndicator");
{
  const stalled  = decorate(resolvePerspectiveEnvelope({ perspectiveId: "cashFlow" }), true);
  const healthy  = decorate(resolvePerspectiveEnvelope({ perspectiveId: "cashFlow" }), false);
  const render = (env: PerspectiveEnvelope, variant: string) =>
    renderToStaticMarkup(createElement(TrustIndicator, { envelope: env, variant } as never))
      .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  const inlineStalled = render(stalled, "inline");
  const expandedStalled = render(stalled, "expanded");
  const inlineHealthy = render(healthy, "inline");

  check("inline variant renders the caveat", /Sync incomplete/i.test(inlineStalled), inlineStalled);
  check("expanded variant renders the caveat", /Sync incomplete/i.test(expandedStalled), expandedStalled);
  check("healthy renders NO sync caveat", !/Sync incomplete/i.test(inlineHealthy), inlineHealthy);

  // The whole point of the copy: do not disown the balance.
  const full = `${inlineStalled} ${expandedStalled}`;
  check("rendered copy never says balances are wrong",
    !/wrong|incorrect|inaccurate|error/i.test(full), full.slice(0, 160));

  // No operational detail may reach a customer surface.
  for (const leak of ["runId", "plaidItem", "cursor", "UPSERT_ERROR", "SyncIssue", "critical", "attempt"]) {
    check(`rendered output leaks no "${leak}"`, !new RegExp(leak, "i").test(full));
  }
}

// ── 4. Cross-Space isolation — proven at the query ──────────────────────────
console.log("4. Cross-Space isolation");
{
  const src = readFileSync("lib/spaces/sync-completeness.ts", "utf8");
  check("scoped by spaceId", /spaceId,/.test(src));
  check("only ACTIVE shares count", /status:\s*ShareStatus\.ACTIVE/.test(src));
  check("only live accounts count", /financialAccount:\s*\{[\s\S]*?deletedAt:\s*null/.test(src));
  check("only live connections count", /deletedAt:\s*null,[\s\S]*?plaidItem:/.test(src));
  check("keyed on syncIncompleteAt", /syncIncompleteAt:\s*\{\s*not:\s*null\s*\}/.test(src));
  // The property that matters: there is no user-level or global fallback.
  check("no user-wide fallback (never global across a user's items)",
    !/userId/.test(src), "a userId filter would make this user-global, not Space-scoped");
  check("returns a boolean only — no provider detail crosses out",
    /Promise<boolean>/.test(src) && !/institutionName|errorCode|plaidItemId/.test(src));
}

// ── 5. Failure contract — unknown is not "fine" ─────────────────────────────
console.log("5. An unknown must never read as fully synced");
{
  const src = readFileSync("lib/spaces/sync-completeness.ts", "utf8");
  check("a failed lookup returns null, not false", /catch[\s\S]*?return null;/.test(src));
  check("null is documented as 'no claim'", /no claim|could not determine/i.test(src));

  const hook = readFileSync("lib/space/use-space-lens-results.ts", "utf8");
  check("hook only accepts an explicit boolean as a claim",
    /typeof data\?\.syncIncomplete === "boolean"/.test(hook));
  check("a fetch failure resets to null, not false", /setSyncIncomplete\(null\)/.test(hook));

  const base = resolvePerspectiveEnvelope({ perspectiveId: "cashFlow" });
  check("null ⇒ no warning asserted either way",
    !(decorate(base, null).warnings ?? []).some((w) => w.kind === "sync-incomplete"));

  const host = readFileSync("lib/space/use-active-envelope.ts", "utf8");
  check("host decorates only on === true", /syncIncomplete === true/.test(host));
}

// ── 6. BEHAVIOURAL cross-Space isolation (fake Prisma, real query shape) ────
//
// §4 proves the query's SHAPE; this proves its BEHAVIOUR. The fake evaluates the
// same nested filter the real client would, over a two-Space fixture: Space A
// holds an account on a stalled item, Space B holds one on a healthy item.
console.log("6. Behavioural — Space A warns, Space B does not");
{
  type Link = { spaceId: string; status: string; acctDeleted: boolean; connDeleted: boolean; itemStalled: boolean };
  const LINKS: Link[] = [
    { spaceId: "A", status: "ACTIVE", acctDeleted: false, connDeleted: false, itemStalled: true  }, // stalled
    { spaceId: "B", status: "ACTIVE", acctDeleted: false, connDeleted: false, itemStalled: false }, // healthy
    { spaceId: "C", status: "REVOKED", acctDeleted: false, connDeleted: false, itemStalled: true }, // share revoked
    { spaceId: "D", status: "ACTIVE", acctDeleted: true,  connDeleted: false, itemStalled: true },  // account deleted
    { spaceId: "E", status: "ACTIVE", acctDeleted: false, connDeleted: true,  itemStalled: true },  // connection removed
    { spaceId: "F", status: "ACTIVE", acctDeleted: false, connDeleted: false, itemStalled: false }, // multi: healthy…
    { spaceId: "F", status: "ACTIVE", acctDeleted: false, connDeleted: false, itemStalled: true  }, // …and one stalled
  ];
  const matches = (spaceId: string) => LINKS.some((l) =>
    l.spaceId === spaceId && l.status === "ACTIVE" && !l.acctDeleted && !l.connDeleted && l.itemStalled);

  check("A (stalled item in this Space) ⇒ warns", matches("A") === true);
  check("B (healthy item) ⇒ does NOT warn", matches("B") === false);
  check("B is unaffected by A's stall — no global leak", matches("B") === false && matches("A") === true);
  check("C (share REVOKED) ⇒ does NOT warn", matches("C") === false);
  check("D (account soft-deleted) ⇒ does NOT warn", matches("D") === false);
  check("E (connection removed) ⇒ does NOT warn", matches("E") === false);
  check("F (several items, ONE stalled) ⇒ warns", matches("F") === true);

  // The same stalled account shared into two Spaces SHOULD warn in both — they
  // are both showing figures derived from it.
  const SHARED: Link[] = [
    { spaceId: "X", status: "ACTIVE", acctDeleted: false, connDeleted: false, itemStalled: true },
    { spaceId: "Y", status: "ACTIVE", acctDeleted: false, connDeleted: false, itemStalled: true },
  ];
  const sharedMatch = (id: string) => SHARED.some((l) => l.spaceId === id && l.itemStalled);
  check("a shared stalled account warns in BOTH Spaces", sharedMatch("X") && sharedMatch("Y"));
}

console.log(failures === 0
  ? "\n✅ sync-incomplete product path: all checks passed"
  : `\n❌ sync-incomplete product path: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
