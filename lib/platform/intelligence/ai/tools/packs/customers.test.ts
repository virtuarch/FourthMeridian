/**
 * lib/platform/intelligence/ai/tools/packs/customers.test.ts  (Platform AI P5 — the customers pack, I-1 / I-3 / I-5 / D-3)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/tools/packs/customers.test.ts
 *
 * Through the REAL turn boundary (authz/boundary.ts) over the E0 reader fixtures (sentinel T2 + an
 * injection payload in every free-text DTO field — eval/fixtures.ts e0CustomerDtos):
 * 1. list_customer_attention / list_recently_joined / get_customer_profile: the closed fields the
 *    oracle expects, handles (never a rid or user id), the audit rows FIRST (one per customer;
 *    PLATFORM_AI_RECORD_VIEWED / CUSTOMER_PROFILE_VIEWED); NO sentinel or injection string anywhere in
 *    what the model receives;
 * 2. refusals: flag OFF, no CS tier, a handle from another turn, no fresh incident token, no server key;
 * 3. the CUSTOMER record source (render / replay): rid = keyed opaque ref; revalidate needs a fresh CS
 *    guard; T2 only through `t2`; a digest collision ⇒ not visible;
 * 4. static: the mappers read no free-text / identity field; the rid is never the user id.
 */

process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "customers-pack-test-secret-not-real";

import { readFileSync } from "node:fs";
import path from "node:path";
import { UserRole, type PlatformArea } from "@prisma/client";
import { E0_CUSTOMERS, E0_CUSTOMER_REF_TOKENS, E0_INJECTION_SENTINELS, E0_T2_SENTINELS, e0CustomerDtos } from "../../eval/fixtures";
import type { BoundaryAuditRow } from "../../authz/boundary";
import type { CustomersPackReaders } from "./customers";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ""}`); }
}

const OP = "cop000000000000000000000cs";
const NOW = new Date("2026-11-10T12:00:00.000Z");
const [ZELDA, ORRIN] = E0_CUSTOMERS;
const leaks = (x: unknown) => {
  const s = JSON.stringify(x).toLowerCase();
  return [...E0_T2_SENTINELS, ...E0_INJECTION_SENTINELS, "e0inj"].filter((v) => s.includes(v.toLowerCase()));
};

function fixtureReaders(over: Partial<CustomersPackReaders> = {}): CustomersPackReaders {
  const dtos = e0CustomerDtos(NOW);
  const byRid = new Map(Object.entries(E0_CUSTOMER_REF_TOKENS).map(([id, t]) => [`u:${t}`, id]));
  return {
    attention: async () => ({ fold: dtos.attention as never }),
    recentlyJoined: async () => dtos.recentlyJoined as never,
    profile: async (userId) => (userId === ZELDA.id ? dtos.profile as never : null),
    ridOf: (id) => (E0_CUSTOMER_REF_TOKENS[id] ? `u:${E0_CUSTOMER_REF_TOKENS[id]}` : null),
    resolveRid: async (rid) => byRid.get(rid) ?? null,
    now: () => NOW,
    ...over,
  };
}

async function main() {
  const { createTurnBoundary } = await import("../../authz/boundary");
  const { scopeFromGuard } = await import("../../authz/scope");
  const { customersPackTools, CUSTOMER_RID } = await import("./customers");
  const auth = { user: { id: OP, role: UserRole.USER }, grant: { area: "CUSTOMER_SUCCESS" as const, level: "READ" as const } };
  const scope = scopeFromGuard(auth, "CUSTOMER_SUCCESS", OP)!;
  const CS_TOKEN = { audience: "CUSTOMER_SUCCESS" } as never;
  const ev = () => ({ envelopes: [], hrefs: new Set<string>(), definitions: [], labels: new Set<string>(), trace: [], pages: new Map() });

  function turn(opts: { readers?: CustomersPackReaders; csTier?: boolean; token?: unknown; flag?: boolean; correlationId?: string; auditFails?: boolean } = {}) {
    const rows: BoundaryAuditRow[] = [];
    const b = createTurnBoundary({
      operatorId: OP, correlationId: opts.correlationId ?? "corr-1", areas: [{ scope, binding: {} as never }], binding: {} as never,
      recheck: async () => ({ auth, csTier: opts.csTier ?? true, ...(opts.token === null ? {} : { incidentToken: (opts.token ?? CS_TOKEN) as never }) }),
      packs: ["customers"], packEnabled: () => opts.flag ?? true,
      registry: customersPackTools(opts.readers ?? fixtureReaders()) as never,
      audit: async (r) => { if (opts.auditFails) throw new Error("down"); rows.push(...r); },
    });
    const call = (name: string, args: unknown) => b.invoke(name, JSON.stringify(args), { ev: ev(), paramKeys: [], asked: [] }) as Promise<Record<string, unknown>>;
    return { b, rows, call };
  }
  type Res = { status: string; truncated: boolean; records: { handle: string; kind: string; fields: Record<string, unknown>; t2Fields?: string[] }[] };
  const NF = JSON.stringify({ found: false });

  console.log("1. the three tools over the sentinel fixtures");
  {
    const t = turn();
    const att = await t.call("list_customer_attention", {}) as unknown as Res;
    check("attention: most reasons first; closed fields (ref, primary reason code, count, testAccount); t2Fields names only",
      att.status === "CONFIRMED" && att.records.length === 2
      && JSON.stringify(att.records.map((r) => r.fields)) === JSON.stringify([
        { ref: "user #a1a1a1a1", reason: "reconnect", reasons: 2, testAccount: false },
        { ref: "user #b2b2b2b2", reason: "stalled", reasons: 1, testAccount: true },
      ]) && att.records.every((r) => r.kind === "CUSTOMER" && /^h_[A-Za-z0-9_-]{16}$/.test(r.handle) && r.t2Fields?.join() === "name,email"), att);
    check("attention: one PLATFORM_AI_RECORD_VIEWED row per customer, written for the records returned",
      t.rows.length === 2 && t.rows.every((r) => r.action === "PLATFORM_AI_RECORD_VIEWED" && r.area === "CUSTOMER_SUCCESS" && r.detail.recordKind === "CUSTOMER")
      && t.rows.map((r) => r.targetUserId).sort().join() === [ZELDA.id, ORRIN.id].sort().join());
    check("attention: NO sentinel (email, name, username, user id) or injection payload in the result", leaks(att).length === 0, leaks(att));
    const filtered = await t.call("list_customer_attention", { reason: "stalled" }) as unknown as Res;
    check("attention reason filter ⇒ that reason only", filtered.records.length === 1 && filtered.records[0].fields.reason === "stalled");
    const none = await t.call("list_customer_attention", { reason: "policy" }) as unknown as Res;
    check("a reason with no customers (no set in this mode) ⇒ MISSING, no records", none.status === "MISSING" && none.records.length === 0);
    check("a free-text reason ⇒ NOT_FOUND (closed enum)", JSON.stringify(await t.call("list_customer_attention", { reason: "zelda" })) === NF);

    const rj = await t.call("list_recently_joined", { days: 14 }) as unknown as Res;
    check("recently joined: closed fields; an unknown stage label (injected) ⇒ null, never echoed",
      rj.status === "CONFIRMED" && rj.records.length === 2 && rj.records[0].fields.stage === "firstConnection" && rj.records[1].fields.stage === null
      && rj.records[0].fields.importHealth === "red" && rj.records[0].fields.invited === true && rj.records[0].fields.connections === 1, rj);
    check("recently joined: NO sentinel or injection", leaks(rj).length === 0, leaks(rj));
    check("days outside the closed bound ⇒ NOT_FOUND", JSON.stringify(await t.call("list_recently_joined", { days: 90 })) === NF);

    const before = t.rows.length;
    const prof = await t.call("get_customer_profile", { customer: att.records[0].handle }) as unknown as Res;
    check("profile by THIS turn's handle: the oracle's closed fields (non-revoked connections, broken, open incidents, presence, stage, AI turns)",
      prof.status === "CONFIRMED" && prof.records.length === 1 && JSON.stringify(prof.records[0].fields) === JSON.stringify({
        ref: "user #a1a1a1a1", joinedAt: new Date(NOW.getTime() - 600 * 60_000).toISOString(), verified: true, deactivated: false, stage: "firstConnection",
        presence: "IDLE", lastActive: "TODAY", connections: 2, brokenConnections: 1, openIncidents: 1, openIncidentsFloor: false, aiTurns30d: 3,
        lastEngagedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
      }), prof);
    check("profile: CUSTOMER_PROFILE_VIEWED row for the customer, written first", t.rows.length === before + 1 && t.rows[before].action === "CUSTOMER_PROFILE_VIEWED" && t.rows[before].targetUserId === ZELDA.id);
    check("profile: NO sentinel or injection (connection labels, error codes, incident account labels, presence labels)", leaks(prof).length === 0, leaks(prof));
    check("profile: a guessed / malformed handle ⇒ NOT_FOUND", JSON.stringify(await t.call("get_customer_profile", { customer: "h_AAAAAAAAAAAAAAAA" })) === NF
      && JSON.stringify(await t.call("get_customer_profile", { customer: ZELDA.id })) === NF);
    const other = turn({ correlationId: "corr-2" });
    check("profile: a handle from ANOTHER turn ⇒ NOT_FOUND (handles are per turn)", JSON.stringify(await other.call("get_customer_profile", { customer: att.records[0].handle })) === NF && other.rows.length === 0);
    check("trace: codes and counts only", t.b.trace().every((x) => /^[a-z_]+$/.test(x.tool) && /^[A-Z_]+$/.test(x.outcome)) && leaks(t.b.trace()).length === 0);
  }

  console.log("\n2. refusals");
  {
    const off = turn({ flag: false });
    check("pack flag OFF ⇒ NOT_FOUND, nothing read, no audit", JSON.stringify(await off.call("list_customer_attention", {})) === NF && off.rows.length === 0);
    const ops = turn({ csTier: false });
    check("no fresh CS tier ⇒ NOT_FOUND (TIER_REFUSED), no audit", JSON.stringify(await ops.call("list_customer_attention", {})) === NF && ops.rows.length === 0
      && ops.b.trace().some((x) => x.outcome === "TIER_REFUSED"));
    const noTok = turn({ token: null });
    const r = await noTok.call("list_customer_attention", {}) as unknown as Res;
    check("no fresh incident token ⇒ UNAVAILABLE (reader refused), no records, no audit", r.status === "UNAVAILABLE" && r.records.length === 0 && noTok.rows.length === 0);
    const opsTok = turn({ token: { audience: "PLATFORM_OPS" } });
    check("an Ops-tier token ⇒ UNAVAILABLE", (await opsTok.call("list_customer_attention", {}) as unknown as Res).status === "UNAVAILABLE");
    const noKey = turn({ readers: fixtureReaders({ ridOf: () => null }) });
    const nk = await noKey.call("list_customer_attention", {}) as unknown as Res;
    check("no server key (ridOf null) ⇒ no record leaves (MISSING), no audit", nk.status === "MISSING" && nk.records.length === 0 && noKey.rows.length === 0);
    const failing = turn({ auditFails: true });
    const fa = await failing.call("list_customer_attention", {}) as unknown as Res;
    check("audit write failure ⇒ UNAVAILABLE, no record data (I-5)", fa.status === "UNAVAILABLE" && fa.records.length === 0 && leaks(fa).length === 0);
    const gone = turn({ readers: fixtureReaders({ resolveRid: async () => null }) });
    const list = await gone.call("list_customer_attention", {}) as unknown as Res;
    check("profile whose rid no longer resolves (deleted / collision) ⇒ NOT_FOUND at revalidate", JSON.stringify(await gone.call("get_customer_profile", { customer: list.records[0].handle })) === NF);
  }

  console.log("\n3. the CUSTOMER record source (render / replay)");
  {
    const { customerRecordSource, customerRid } = await import("./customers.server");
    const { opaqueUserRef } = await import("@/lib/platform/opaque-user-ref");
    const rid = customerRid(ZELDA.id)!;
    check("rid = \"u:\" + the PRIV-ref token of the user id — never the id", CUSTOMER_RID.test(rid) && `user #${rid.slice(2)}` === opaqueUserRef(ZELDA.id) && !rid.includes(ZELDA.id));
    const users = [{ id: ZELDA.id, email: ZELDA.email, name: ZELDA.name, role: "USER" }, { id: "cstaffnotacustomer0000001", email: "s@x.invalid", name: "S", role: "SYSTEM_ADMIN" }];
    const fakeClient = {
      user: {
        findMany: async (a: { where?: { AND?: [unknown, { id: { in: string[] } }] }; take?: number }) => {
          const ids = a.where?.AND?.[1]?.id?.in;
          return users.filter((u) => (ids ? ids.includes(u.id) && u.role === "USER" : true)).map((u) => ({ id: u.id }));
        },
        findUnique: async (a: { where: { id: string } }) => users.find((u) => u.id === a.where.id) ?? null,
      },
    };
    const src = customerRecordSource(fakeClient as never);
    const csGuard = { auth, csTier: true };
    check("revalidate: a fresh CS guard on the CS area ⇒ CUSTOMER_SUCCESS", (await src.revalidate(rid, "CUSTOMER_SUCCESS", csGuard)) === "CUSTOMER_SUCCESS");
    check("revalidate: no CS tier, or another area ⇒ not visible", (await src.revalidate(rid, "CUSTOMER_SUCCESS", { auth, csTier: false })) === null
      && (await src.revalidate(rid, "PLATFORM_OPS" as PlatformArea, csGuard)) === null);
    check("t1 = the opaque ref; linkedUserIds = the customer; t2 = the value (renderer-only path)",
      (await src.t1(rid, "CUSTOMER_SUCCESS")) === opaqueUserRef(ZELDA.id) && (await src.linkedUserIds(rid, "CUSTOMER_SUCCESS")).join() === ZELDA.id
      && (await src.t2(rid, "CUSTOMER_SUCCESS", "email")) === ZELDA.email);
    const staffRid = customerRid(users[1].id)!;
    check("a non-customer (staff) account never resolves", (await src.revalidate(staffRid, "CUSTOMER_SUCCESS", csGuard)) === null);
    check("a malformed rid never resolves", (await src.revalidate(ZELDA.id, "CUSTOMER_SUCCESS", csGuard)) === null);

    // S2 P5 follow-up (c): a scan that reaches REF_SEARCH_SCAN_CAP is truncated ⇒ fail closed + counts-only log.
    const { resolveCustomerRid } = await import("./customers.server");
    const { REF_SEARCH_SCAN_CAP } = await import("@/lib/platform/customer/customers");
    const fill = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `cfill${String(i).padStart(20, "0")}`, email: `f${i}@x.invalid`, name: "F", role: "USER" }));
    const cappedClient = (rows: typeof users) => ({
      user: {
        findMany: async (a: { where?: { AND?: [unknown, { id: { in: string[] } }] }; take?: number }) => {
          const ids = a.where?.AND?.[1]?.id?.in;
          const hit = rows.filter((u) => (ids ? ids.includes(u.id) && u.role === "USER" : true));
          return hit.slice(0, a.take ?? hit.length).map((u) => ({ id: u.id }));
        },
        findUnique: async (a: { where: { id: string } }) => rows.find((u) => u.id === a.where.id) ?? null,
      },
    });
    const logged: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    try {
      // Zelda IS among the newest cap rows (a match), yet the scan was truncated: uniqueness unproven ⇒ null.
      const withMatch = cappedClient([users[0], ...fill(REF_SEARCH_SCAN_CAP + 5)]);
      const r1 = await resolveCustomerRid(rid, withMatch as never);
      const s1 = customerRecordSource(withMatch as never);
      const rv = await s1.revalidate(rid, "CUSTOMER_SUCCESS", csGuard);
      const t2 = await s1.t2(rid, "CUSTOMER_SUCCESS", "email");
      let linked = "returned";
      try { await s1.linkedUserIds(rid, "CUSTOMER_SUCCESS"); } catch { linked = "threw"; }
      check("capped scan WITH a match among the newest cap ⇒ not resolved (fail closed): resolve null, revalidate null, t2 null, linkedUserIds throws",
        r1 === null && rv === null && t2 === null && linked === "threw", { r1, rv, t2, linked });
      // Zelda older than the cap (not scanned) ⇒ no match ⇒ the same uniform not-resolved.
      const noMatch = cappedClient([...fill(REF_SEARCH_SCAN_CAP + 5), users[0]]);
      check("capped scan with NO match ⇒ the same uniform null", (await resolveCustomerRid(rid, noMatch as never)) === null);
      // Below the cap, the same customer still resolves (the cap, not the population, closes it).
      const under = cappedClient([users[0], ...fill(REF_SEARCH_SCAN_CAP - 2)]);
      check("an uncapped scan (cap − 1 rows) still resolves the one customer", (await resolveCustomerRid(rid, under as never)) === ZELDA.id);
    } finally {
      console.warn = warn;
    }
    const capLines = logged.filter((l) => l.includes("failed closed"));
    check("every capped resolution emits ONE counts-only line (5 capped calls ⇒ 5 lines; none for the uncapped call)", capLines.length === 5 && logged.length === 5, logged.length);
    const leaked = capLines.filter((l) => l.includes(ZELDA.id) || l.includes(rid.slice(2)) || l.includes("@") || /cfill|user #/.test(l)
      || l.replace(/\[platform-ai\][^:]*:[^(]*\((scanned=\d+, cap=\d+, matches=\d+)\)/, "").trim() !== "");
    check("the capped line carries counts only — no id, no ref, no email", leaked.length === 0 && capLines[0].includes(`cap=${REF_SEARCH_SCAN_CAP}`), capLines[0]);
  }

  console.log("\n4. static");
  {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/description: "[^"]*"/g, "");
    const pack = strip(readFileSync(path.join(process.cwd(), "lib/platform/intelligence/ai/tools/packs/customers.ts"), "utf8"));
    const banned = ["\\.email\\b", "\\.name\\b", "\\.username\\b", "\\.label\\b", "\\.errorCode\\b", "\\.account\\b", "\\.institution", "\\.details\\b", "presenceLabel", "\\.cohorts\\b", "\\.policy\\b", "\\.lifecycle\\b", "\\.\\.\\.(?:r|p|row|dto|c)\\b"];
    const hit = banned.filter((b) => new RegExp(b).test(pack));
    check("the mappers read no identity or free-text field and never spread a DTO", hit.length === 0, hit);
    check("customers.ts is pure (no DB, env, clock)", !/@\/lib\/db|systemDb|process\.env|new Date\(\)|Date\.now/.test(pack));
    check("the record ref's recordId is the keyed rid (readers.ridOf), never the user id", /recordId: rid/.test(pack) && !/recordId: userId/.test(pack));
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
