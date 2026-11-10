/**
 * lib/platform/security/live-sessions.test.ts  (shared live-session COUNT readers)
 *
 * The move from the route handlers into ./live-sessions.ts is a pure refactor:
 *   1. OLD vs NEW on fixtures — the queries the routes ran inline (copied
 *      verbatim below as OLD) and the shared readers issue the SAME Prisma
 *      calls with the SAME arguments, and yield the SAME values;
 *   2. the routes call the readers (and no longer inline the counts), with the
 *      readers built on liveSessionWhere and CUSTOMER_WHERE — never a copy;
 *   3. the registry chain names the readers (registry.test.ts pins the hops).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/security/live-sessions.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { liveSessionWhere } from "@/lib/auth/session-proof";
import { CUSTOMER_WHERE } from "@/lib/platform/customer/population";
import { METRICS } from "@/lib/platform/intelligence/metrics/registry";
import { countAccountsWithLiveSession, countLiveSessions, type LiveSessionReadClient } from "./live-sessions";
import { toPlatformSessionRow } from "./session-rows";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (f: string) => readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

interface Call { method: string; args: unknown }
/** A fake client: records every userSession call, answers from fixtures. */
function fake(fx: { count: number; owners: string[]; customerOwners: string[] }) {
  const calls: Call[] = [];
  const client = {
    userSession: {
      count: async (args: unknown) => { calls.push({ method: "count", args }); return fx.count; },
      groupBy: async (args: { where: { user?: { is?: { role?: string } } } }) => {
        calls.push({ method: "groupBy", args });
        const ids = args.where.user?.is?.role === "USER" ? fx.customerOwners : fx.owners;
        return ids.map((userId) => ({ userId, _count: { _all: 1 } }));
      },
    },
  };
  return { calls, client: client as unknown as LiveSessionReadClient };
}

const NOW = new Date("2026-11-04T12:00:00.000Z");
const FX = { count: 7, owners: ["u1", "u2", "u3"], customerOwners: ["u1", "u2"] };

// ── OLD: the route handlers' inline queries, verbatim (before the move) ─────
async function oldSecuritySessions(db: LiveSessionReadClient, now: Date) {
  const live = liveSessionWhere(now);
  const [totalActive, distinctUsers] = await Promise.all([
    db.userSession.count({ where: live }),
    db.userSession.groupBy({ by: ["userId"], where: live }),
  ]);
  return { totalActive, distinctUsers: distinctUsers.length };
}
async function oldGrowthWithLiveSession(db: LiveSessionReadClient, now: Date) {
  const customer = CUSTOMER_WHERE;
  const liveSessionUsers = await db.userSession.groupBy({ by: ["userId"], where: liveSessionWhere(now, { userWhere: customer }), _count: { _all: true } });
  return liveSessionUsers.length;
}

async function main(): Promise<void> {
  console.log("\nlive-session readers\n");

  console.log("1. OLD vs NEW on fixtures — same calls, same arguments, same values");
  {
    const o = fake(FX), n = fake(FX);
    const before = await oldSecuritySessions(o.client, NOW);
    const after = await countLiveSessions(n.client, NOW);
    check("live-sessions@1: same Prisma calls with identical arguments", JSON.stringify(o.calls) === JSON.stringify(n.calls), JSON.stringify(n.calls));
    check("live-sessions@1: totalActive = sessions, distinctUsers = distinctUsers",
      before.totalActive === after.sessions && before.distinctUsers === after.distinctUsers && after.sessions === 7 && after.distinctUsers === 3);
  }
  {
    const o = fake(FX), n = fake(FX);
    const before = await oldGrowthWithLiveSession(o.client, NOW);
    const after = await countAccountsWithLiveSession(n.client, NOW);
    check("accounts-with-live-session@1: the same groupBy with identical arguments", JSON.stringify(o.calls) === JSON.stringify(n.calls), JSON.stringify(n.calls));
    check("accounts-with-live-session@1: withLiveSession unchanged (customer owners only)", before === after && after === 2);
  }
  {
    const empty = { count: 0, owners: [], customerOwners: [] };
    const a = await countLiveSessions(fake(empty).client, NOW);
    check("no live sessions ⇒ the measured 0 the route returned before (a real count, not missing data)",
      a.sessions === (await oldSecuritySessions(fake(empty).client, NOW)).totalActive && a.distinctUsers === 0);
  }
  {
    const later = new Date(NOW.getTime() + 3_600_000);
    const n = fake(FX);
    await countLiveSessions(n.client, later);
    check("the reader's clock is the caller's now (liveSessionWhere(now) cut-offs move with it)",
      JSON.stringify((n.calls[0].args as { where: unknown }).where) === JSON.stringify(liveSessionWhere(later)));
  }

  console.log("\n2. the routes call the readers; the readers use the shared rule, never a copy");
  {
    const sec = code("app/api/platform/security-ops/sessions/route.ts");
    const gro = code("app/api/platform/growth-revenue/users/route.ts");
    const lib = code("lib/platform/security/live-sessions.ts");
    check("Security sessions route counts through countLiveSessions(db, now) and no longer inlines count / groupBy",
      /countLiveSessions\(db, now\)/.test(sec) && !/userSession\.count\(|userSession\.groupBy\(/.test(sec));
    // P12a: the recent list moved verbatim into lib/platform/security/sessions.ts; the route hands it the SAME now.
    const recentReader = code("lib/platform/security/sessions.ts");
    check("…its recent list reads the same rule at the same clock (liveSessionWhere(now))",
      /listRecentLiveSessions\(db, now\)/.test(sec) && /const live = liveSessionWhere\(now\);/.test(recentReader) && /where:\s*live/.test(recentReader));
    check("Growth users route counts through countAccountsWithLiveSession(db, now) and no longer inlines the groupBy",
      /countAccountsWithLiveSession\(db, now\)/.test(gro) && !/userSession\./.test(gro) && !/liveSessionWhere/.test(gro));
    check("the readers import liveSessionWhere and CUSTOMER_WHERE from their owning modules",
      /import \{ liveSessionWhere \} from "@\/lib\/auth\/session-proof";/.test(lib) && /import \{ CUSTOMER_WHERE \} from "@\/lib\/platform\/customer\/population";/.test(lib));
    check("the readers restate no predicate (no revokedAt / createdAt / lastActiveAt / role literal)", !/revokedAt|createdAt|lastActiveAt|role\s*:/.test(lib));
    check("the readers take the caller's client: no db import, no default authority", !/@\/lib\/db/.test(lib) && !/\?\?\s*db\b|=\s*db\b/.test(lib));
    check("aggregates only: no findMany / select / identity field", !/findMany|select\s*:|email|userAgent/.test(lib));
  }

  console.log("\n3. the registry chain names the readers");
  {
    const by = (id: string) => METRICS.find((m) => m.id === id)!;
    const ls = by("live-sessions"), acc = by("accounts-with-live-session");
    check("live-sessions@1: route → countLiveSessions → liveSessionWhere",
      ls.path.map((h) => h.calls).join(" → ") === "countLiveSessions → liveSessionWhere" && ls.path[1].file === "lib/platform/security/live-sessions.ts");
    check("accounts-with-live-session@1: route → countAccountsWithLiveSession → liveSessionWhere",
      acc.path.map((h) => h.calls).join(" → ") === "countAccountsWithLiveSession → liveSessionWhere" && acc.path[1].file === "lib/platform/security/live-sessions.ts");
    check("compute stays THE live rule (liveSessionWhere in session-proof)", [ls, acc].every((m) => m.compute.module === "lib/auth/session-proof.ts" && m.compute.symbol === "liveSessionWhere"));
  }

  console.log("\n4. the recent-sessions list is identity-free (registry live-sessions@1 drill note)");
  {
    const row = toPlatformSessionRow({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36", lastActiveAt: new Date("2026-11-01T12:00:00Z") });
    check("a row carries exactly device · browser · os · at", JSON.stringify(Object.keys(row).sort()) === JSON.stringify(["at", "browser", "device", "os"]));
    const ser = JSON.stringify(row);
    check("a row has no id key and no cuid-shaped value", !/"id"/.test(ser) && !/\bc[a-z0-9]{24}\b/.test(ser));
    const route = code("app/api/platform/security-ops/sessions/route.ts");
    // P12a: the mapping moved with the query into lib/platform/security/sessions.ts.
    const reader = code("lib/platform/security/sessions.ts");
    check("the reader maps rows through toPlatformSessionRow", /recent\.map\(toPlatformSessionRow\)/.test(reader));
    check("the route and reader never select or emit a session id", [route, reader].every((s) => !/\bid:\s*true/.test(s) && !/\bid:\s*s\./.test(s)));
    const drill = METRICS.find((m) => m.id === "live-sessions")!.drill;
    const note = (drill && "note" in drill ? drill.note : undefined) ?? "";
    check("the registry drill note states the contract this pins", /never a session id/.test(note));
    check("the widget keys rows without an id", !/key=\{s\.id\}/.test(code("components/platform/widgets/SecSessionsWidget.tsx")));
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
