/**
 * lib/spaces/default-space.test.ts
 *
 * DEFAULT-SPACE — the Default Space is a PREFERENCE, never an authority. Pure
 * checks plus source pins (house-style standalone tsx script, auto-discovered
 * by scripts/run-tests.ts). The database half — that setting it touches no
 * membership, that eligibility and resolution cannot cross a tenant on a real
 * fm_app role, and the owner's Preview sequence end to end — lives in
 * scripts/rls-app-acceptance.ts ("[default-space]").
 *
 * THE OWNER'S PREVIEW INCIDENT (2026-10-06), two defects, no membership change:
 *   1. Settings → Preferences sends `""` for "Personal Space (default)" and for
 *      "Reset to default"; PATCH /api/user/profile treated only `null` as a
 *      clear, looked `""` up as a Space id and answered 403 "Not a member of
 *      that Space".
 *   2. The Spaces page read the RAW active-Space cookie and, with none set,
 *      assumed the personal Space was active — while getSpaceContext resolves
 *      cookie → PREFERRED → personal. With a shared default set, opening the
 *      personal Space looked already-active, pushed /dashboard with no switch,
 *      and landed back in the shared default.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseDefaultSpaceInput, effectiveDefaultSpaceId } from "./default-space";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
/** Source with comments stripped, so a pin cannot be satisfied by prose. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ── A. parseDefaultSpaceInput — what a PATCH may ask for ─────────────────────
{
  const empty = parseDefaultSpaceInput("");
  check("A1 \"\" (Preferences' \"Personal Space (default)\" / \"Reset to default\") CLEARS the preference — it is not a Space id",
    empty.ok && empty.spaceId === null, JSON.stringify(empty));
  const nul = parseDefaultSpaceInput(null);
  check("A2 null clears the preference", nul.ok && nul.spaceId === null, JSON.stringify(nul));
  const named = parseDefaultSpaceInput("space_s");
  check("A3 a non-empty id names a Space (eligibility is decided separately, on the tenant role)",
    named.ok && named.spaceId === "space_s", JSON.stringify(named));
  for (const bad of [42, true, {}, [], "   "]) {
    const r = parseDefaultSpaceInput(bad);
    check(`A4 malformed input ${JSON.stringify(bad)} is refused, never coerced into a lookup`, !r.ok, JSON.stringify(r));
  }
}

// ── B. effectiveDefaultSpaceId — mirrors the resolver's no-cookie landing ────
{
  const eligible = ["space_a", "space_s"];
  check("B1 a valid preference is the default", effectiveDefaultSpaceId("space_s", eligible, "space_a") === "space_s");
  check("B2 no preference ⇒ the personal Space", effectiveDefaultSpaceId(null, eligible, "space_a") === "space_a");
  check("B3 a STALE preference (left / archived / another tenant's) is not the default — the personal Space is",
    effectiveDefaultSpaceId("space_b", eligible, "space_a") === "space_a");
  check("B4 a stale preference with no personal Space yields null, never the stale id",
    effectiveDefaultSpaceId("space_b", eligible, null) === null);
}

// ── C. Source pins — one default control, and it is a preference write ───────
{
  const client = code("components/dashboard/SpacesClient.tsx");
  check("C1 the Spaces surface no longer exposes a Make Default control (no \"Set as default Space\", no onSetDefault)",
    !client.includes("Set as default Space") && !/onSetDefault|handleSetDefault|settingDefault/.test(client));
  check("C2 the Spaces surface no longer writes the preference at all (no PATCH /api/user/profile, no preferredSpaceId body)",
    !client.includes("/api/user/profile") && !/preferredSpaceId\s*:\s*newVal/.test(client));
  check("C3 the Spaces surface still SWITCHES Spaces through /api/space/switch (navigation among authorized Spaces kept)",
    client.includes('fetch("/api/space/switch"'));
  check("C4 its crown indicator shows the EFFECTIVE default (stale preference ⇒ personal), not the raw stored value",
    client.includes("effectiveDefaultSpaceId(") && client.includes("isDefault={defaultId === space.id}"));

  const prefs = code("components/settings/PreferencesSettings.tsx");
  check("C5 Settings → Preferences → Default Space remains, and saves preferredSpaceId",
    prefs.includes('title="Default Space"') && prefs.includes("saveField({ preferredSpaceId:"));
  check("C6 Preferences still offers \"Personal Space (default)\" as the clear option",
    /\{\s*value:\s*"",\s*label:\s*"Personal Space \(default\)"\s*\}/.test(prefs));

  const route = code("app/api/user/profile/route.ts");
  check("C7 the profile route parses the value through parseDefaultSpaceInput (\"\" and null both clear)",
    route.includes("parseDefaultSpaceInput(preferredSpaceId)") && !route.includes("preferredSpaceId !== null"));
  check("C8 a named default must be ELIGIBLE, checked on the caller's tenant transaction (fm_app), and refused 403 otherwise",
    /withTenantDb\(user\.id,\s*\(tx\)\s*=>\s*isEligibleDefaultSpace\(tx,\s*user\.id,/.test(route)
    && route.includes('"Not a member of that Space" }, { status: 403 }'));
  check("C9 the profile route writes NO membership row — setting a default cannot grant, revoke or change membership",
    !/spaceMember\.(create|update|upsert|delete)/.test(route));

  const helper = code("lib/spaces/default-space.ts");
  check("C10 the eligibility predicate is a READ (no write of any kind) matching the resolver: ACTIVE, not archived, not trashed",
    !/\.(create|update|upsert|delete)(Many)?\(/.test(helper)
    && /status:\s*"ACTIVE",\s*space:\s*\{\s*archivedAt:\s*null,\s*deletedAt:\s*null\s*\}/.test(helper));

  const page = code("app/(shell)/dashboard/spaces/page.tsx");
  check("C11 the Spaces page takes the active Space from the SERVER resolver (getSpaceContext), not the raw cookie",
    page.includes("getSpaceContext().then((ctx) => ctx.spaceId") && !page.includes("ACTIVE_SPACE_COOKIE"));

  const space = code("lib/space.ts");
  const cookieAt = space.indexOf("jar.get(ACTIVE_SPACE_COOKIE)");
  const prefAt   = space.indexOf("select: { preferredSpaceId: true }");
  const resolveAt = space.indexOf("resolveSpaceContext(session.user.id, requestedId");
  check("C12 current Space = active-Space cookie, then the preference ONLY when no cookie, then the resolver",
    cookieAt > 0 && prefAt > cookieAt && resolveAt > prefAt && /if \(!requestedId\)\s*\{/.test(space));
  check("C13 the resolver honours a requested Space only on the caller's ACTIVE membership in a live Space, and falls back on their OWN rows",
    space.includes('membership.status === "ACTIVE" && !membership.space.archivedAt && !membership.space.deletedAt')
    && /where:\s*\{\s*userId,\s*status:\s*"ACTIVE",\s*role:\s*"OWNER",\s*space:\s*\{\s*type:\s*"PERSONAL"/.test(space));

  const nav = code("lib/space-nav.ts");
  check("C14 My Space is /dashboard — the CURRENT Space (cookie → default → personal), unchanged by this fix",
    nav.includes('export const MY_SPACE_HREF = "/dashboard"') && nav.includes('label: "My Space",    href: MY_SPACE_HREF'));

  const chat = code("app/api/ai/chat/route.ts");
  check("C15 AI chat re-resolves the named Space through resolveSpaceContext (membership-checked), never the stored preference",
    chat.includes("resolveSpaceContext(user.id, parsed.spaceId)") && !chat.includes("preferredSpaceId"));
}

if (failures.length) {
  console.error(`\ndefault-space: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`default-space: ${passed} checks passed`);
