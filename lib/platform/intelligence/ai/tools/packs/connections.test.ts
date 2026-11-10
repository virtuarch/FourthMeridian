/**
 * lib/platform/intelligence/ai/tools/packs/connections.test.ts  (Platform AI P7 — the connections pack incl. wallets, I-3 / I-5 / S2 09dx)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/tools/packs/connections.test.ts
 *
 * Through the REAL turn boundary (authz/boundary.ts) over the E0 reader fixtures (eval/fixtures.ts e0ConnectionsDtos —
 * injected institution names / error codes / labels, a wallet-address SENTINEL and its tail, nicknames, masks,
 * balances and an email on every row):
 * 1. connection_health_overview: identity-free counts; institutions ONLY via the static registry (unlisted ⇒
 *    "institution"); error codes ONLY when allowlisted (else OTHER; INVALID_WALLET_ADDRESS / NO_USED_ADDRESSES are fixed
 *    codes, S2 09dy(1), never accompanied by an address / fragment / name / format hint); networks as
 *    chain codes; no address / tail / nickname / label / email; no audit; a failed reader ⇒ UNAVAILABLE;
 * 2. get_customer_connections: the oracle's closed CONNECTION fields per live connection, one
 *    PLATFORM_AI_RECORD_VIEWED row (the owner), Ops ⇒ NOT_FOUND, audit failure ⇒ UNAVAILABLE, another turn's
 *    handle ⇒ NOT_FOUND, no key ⇒ nothing;
 * 3. the server reader + CONNECTION record source over a fake client: allowlisted selects (never institutionName,
 *    externalConnectionId, names, balances), health.ts's derivation, removed wallets skipped, CS-only revalidate,
 *    code-derived T1, no T2;
 * 4. static: the mappers read none of the excluded fields.
 */

process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "connections-pack-test-secret-not-real";

import { readFileSync } from "node:fs";
import path from "node:path";
import { UserRole, type PlatformArea } from "@prisma/client";
import {
  E0_CUSTOMERS, E0_INJECTION_SENTINELS, E0_KNOWN_INSTITUTION_ID, E0_T2_SENTINELS, E0_WALLET_ADDRESS, E0_WALLET_FORMAT_HINT, E0_WALLET_NICKNAME, e0ConnectionsReaders,
} from "../../eval/fixtures";
import type { BoundaryAuditRow } from "../../authz/boundary";
import type { ConnectionsPackReaders } from "./connections";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 900)}` : ""}`); }
}

const OP = "cop000000000000000000000co";
const NOW = new Date("2026-11-10T12:00:00.000Z");
const [ZELDA] = E0_CUSTOMERS;
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const PLANTED = [...E0_T2_SENTINELS, ...E0_INJECTION_SENTINELS, "e0inj", E0_WALLET_ADDRESS, E0_WALLET_ADDRESS.slice(-6), E0_WALLET_NICKNAME, E0_WALLET_FORMAT_HINT, "e0formatsentinel", "segwit", "4417", "98765"];
/** S2 09dy(1): what must NEVER accompany INVALID_WALLET_ADDRESS / NO_USED_ADDRESSES — the address, a fragment, the wallet name, a format hint. */
const ADDRESS_BEARING = [E0_WALLET_ADDRESS, E0_WALLET_ADDRESS.slice(-6), E0_WALLET_ADDRESS.slice(0, 8), E0_WALLET_NICKNAME, "cold storage", E0_WALLET_FORMAT_HINT, "e0formatsentinel", "extended-key", "segwit", "xpub", "bech32"];
const sentinelHits = (x: unknown, list: readonly string[]) => {
  const s = (typeof x === "string" ? x : JSON.stringify(x)).toLowerCase();
  return list.filter((v) => s.includes(v.toLowerCase()));
};
const leaks = (x: unknown) => {
  const s = JSON.stringify(x).toLowerCase();
  return PLANTED.filter((v) => s.includes(v.toLowerCase()));
};

async function main() {
  const { createTurnBoundary } = await import("../../authz/boundary");
  const { scopeFromGuard } = await import("../../authz/scope");
  const { connectionsPackTools, CONNECTION_TOOL_NAMES, networkCodeOf, errorCodeOf } = await import("./connections");
  const { INSTITUTIONS, UNLISTED_INSTITUTION } = await import("../../evidence/name-registry");
  const KNOWN = INSTITUTIONS[E0_KNOWN_INSTITUTION_ID];
  const authFor = (area: PlatformArea) => ({ user: { id: OP, role: UserRole.USER }, grant: { area, level: "READ" as const } });
  const TOKEN: Record<string, unknown> = { CUSTOMER_SUCCESS: { audience: "CUSTOMER_SUCCESS" }, PLATFORM_OPS: { audience: "PLATFORM_OPS" } };
  const ev = () => ({ envelopes: [], hrefs: new Set<string>(), definitions: [], labels: new Set<string>(), trace: [], pages: new Map() });

  function turn(opts: { areas?: PlatformArea[]; readers?: ConnectionsPackReaders; correlationId?: string; auditFails?: boolean } = {}) {
    const areas = opts.areas ?? ["CUSTOMER_SUCCESS"];
    const rows: BoundaryAuditRow[] = [];
    const b = createTurnBoundary({
      operatorId: OP, correlationId: opts.correlationId ?? "corr-1",
      areas: areas.map((a) => ({ scope: scopeFromGuard(authFor(a), a, OP)!, binding: {} as never })), binding: {} as never,
      recheck: async (a) => ({ auth: authFor(a), csTier: a === "CUSTOMER_SUCCESS", incidentToken: TOKEN[a] as never }),
      packs: ["connections"], packEnabled: () => true,
      registry: connectionsPackTools(opts.readers ?? e0ConnectionsReaders(NOW)) as never,
      audit: async (r) => { if (opts.auditFails) throw new Error("down"); rows.push(...r); },
    });
    const call = (name: string, args: unknown) => b.invoke(name, JSON.stringify(args), { ev: ev(), paramKeys: [], asked: [] }) as Promise<Record<string, unknown>>;
    return { b, rows, call };
  }
  type Res = { status: string; truncated: boolean; records: { handle: string; kind: string; fields: Record<string, unknown>; t2Fields?: string[] }[] };
  const NF = JSON.stringify({ found: false });

  console.log("0. the closed vocabularies");
  check("networkCodeOf: one registry chain ⇒ that code; several ⇒ MULTIPLE; none / unknown / an address-shaped string ⇒ OTHER",
    networkCodeOf(["ETH"]) === "ETH" && networkCodeOf(["eth", "ETH"]) === "ETH" && networkCodeOf(["BTC", "SOL"]) === "MULTIPLE"
    && networkCodeOf([]) === "OTHER" && networkCodeOf([null]) === "OTHER" && networkCodeOf([E0_WALLET_ADDRESS]) === "OTHER");
  check("errorCodeOf: Plaid allowlist / wallet sync codes pass; INVALID_WALLET_ADDRESS + NO_USED_ADDRESSES pass as FIXED codes (S2 09dy(1)); provider text / a Plaid code on a wallet ⇒ OTHER; none ⇒ null",
    errorCodeOf("PLAID", "ITEM_LOGIN_REQUIRED") === "ITEM_LOGIN_REQUIRED" && errorCodeOf("WALLET", "BALANCE_UNAVAILABLE") === "BALANCE_UNAVAILABLE"
    && errorCodeOf("WALLET", "INVALID_WALLET_ADDRESS") === "INVALID_WALLET_ADDRESS" && errorCodeOf("WALLET", "NO_USED_ADDRESSES") === "NO_USED_ADDRESSES"
    && errorCodeOf("WALLET", `INVALID_WALLET_ADDRESS ${E0_WALLET_ADDRESS}`) === "OTHER" && errorCodeOf("PLAID", "NO_USED_ADDRESSES") === "OTHER"
    && errorCodeOf("PLAID", "the bank said: please call 555") === "OTHER" && errorCodeOf("WALLET", "ITEM_LOGIN_REQUIRED") === "OTHER" && errorCodeOf("PLAID", null) === null);

  console.log("\n1. connection_health_overview (AGGREGATE, identity-free)");
  {
    const ops = turn({ areas: ["PLATFORM_OPS"] });
    const o = await ops.call("connection_health_overview", {}) as Record<string, unknown>;
    check("counts: total, byHealth, retired; per source faults by state + ALLOWLISTED code (injected ⇒ OTHER; INVALID_WALLET_ADDRESS a fixed code); no institution refs",
      o.status === "CONFIRMED" && o.total === 4 && JSON.stringify(o.byHealth) === JSON.stringify({ HEALTHY: 1, STALE: 0, DEGRADED: 1, NEEDS_REAUTH: 1, ERROR: 1, REVOKED: 0 })
      && JSON.stringify(o.retired) === JSON.stringify({ revoked: 1, ownerInactive: 0 })
      && JSON.stringify(o.bySource) === JSON.stringify({
        PLAID: { active: 3, revoked: 1, faults: [{ healthState: "ERROR", errorCode: "OTHER", count: 1 }, { healthState: "NEEDS_REAUTH", errorCode: "ITEM_LOGIN_REQUIRED", count: 1 }] },
        WALLET: { active: 1, revoked: 0, faults: [{ healthState: "DEGRADED", errorCode: "INVALID_WALLET_ADDRESS", count: 1 }] },
      }), o);
    check("S2 09dy(1): the aggregate carrying INVALID_WALLET_ADDRESS carries NO address / fragment / wallet name / format hint",
      JSON.stringify(o).includes("INVALID_WALLET_ADDRESS") && sentinelHits(o, ADDRESS_BEARING).length === 0, sentinelHits(o, ADDRESS_BEARING));
    const inst = (o.unhealthyByInstitution ?? []) as { institution: string; count: number }[];
    check("institutions ONLY via the registry keyed by institutionId: a verified id ⇒ its registry name, an unlisted id ⇒ the generic word",
      inst.length === 2 && inst.some((x) => x.institution === KNOWN && x.count === 1) && inst.some((x) => x.institution === UNLISTED_INSTITUTION && x.count === 1), inst);
    check("wallet networks as chain CODES; neverSynced counted; the listed rows are not a floor",
      JSON.stringify(o.unhealthyByNetwork) === JSON.stringify([{ network: "ETH", count: 1 }]) && o.neverSyncedListed === 1 && o.listFloor === false);
    check("NO address / address tail / nickname / label / injected text / email / mask / balance in the result", leaks(o).length === 0, leaks(o));
    check("no audit row (counts carry no linkage)", ops.rows.length === 0);
    const cs = await turn({ areas: ["CUSTOMER_SUCCESS"] }).call("connection_health_overview", {}) as Record<string, unknown>;
    check("the same counts for a CS-only operator (counts only either way)", JSON.stringify({ ...cs }) === JSON.stringify({ ...o }));
    const broken = await turn({ areas: ["PLATFORM_OPS"], readers: e0ConnectionsReaders(NOW, { health: async () => { throw new Error("db down"); } }) }).call("connection_health_overview", {}) as Record<string, unknown>;
    check("a failed reader ⇒ UNAVAILABLE with no figures", broken.status === "UNAVAILABLE" && !("total" in broken), broken);
    check("an argument ⇒ NOT_FOUND (closed, empty schema)", JSON.stringify(await ops.call("connection_health_overview", { source: "PLAID" })) === NF);
  }

  console.log("\n2. get_customer_connections (CS-tier RECORD, audited)");
  {
    // The customer handle comes from server-side subject adoption (authz/subject.ts's path) over a fixture CUSTOMER source.
    const rows: BoundaryAuditRow[] = [];
    const tt = createTurnBoundary({
      operatorId: OP, correlationId: "corr-2", areas: [{ scope: scopeFromGuard(authFor("CUSTOMER_SUCCESS"), "CUSTOMER_SUCCESS", OP)!, binding: {} as never }], binding: {} as never,
      recheck: async (a) => ({ auth: authFor(a), csTier: true, incidentToken: TOKEN[a] as never }),
      packs: ["connections"], packEnabled: () => true, registry: connectionsPackTools(e0ConnectionsReaders(NOW)) as never,
      recordSources: { CUSTOMER: { t2Fields: ["name", "email"], revalidate: async (rid) => (rid === "u:a1a1a1a1" ? "CUSTOMER_SUCCESS" : null), t1: async () => "user #a1a1a1a1", linkedUserIds: async () => [ZELDA.id], t2: async () => null } },
      audit: async (r) => { rows.push(...r); },
    });
    const handle = await tt.adoptSubject({ rk: "CUSTOMER", rid: "u:a1a1a1a1", area: "CUSTOMER_SUCCESS" });
    const call = (name: string, args: unknown) => tt.invoke(name, JSON.stringify(args), { ev: ev(), paramKeys: [], asked: [] }) as Promise<Record<string, unknown>>;
    const r = await call("get_customer_connections", { customer: handle }) as unknown as Res;
    const base = { customer: "user #a1a1a1a1" };
    check("one CONNECTION record per live connection: registry institution, chain CODE (several ⇒ MULTIPLE), allowlisted codes, needsReauth, times",
      r.status === "CONFIRMED" && JSON.stringify(r.records.map((x) => x.fields)) === JSON.stringify([
        { ...base, provider: "PLAID", kind: "BANK", institution: KNOWN, network: null, status: "ERROR", healthState: "ERROR", errorCode: "OTHER", needsReauth: false, lastSyncedAt: ago(120), neverSynced: false, connectedAt: ago(500) },
        { ...base, provider: "WALLET", kind: "WALLET", institution: null, network: "ETH", status: "ACTIVE", healthState: "DEGRADED", errorCode: "INVALID_WALLET_ADDRESS", needsReauth: false, lastSyncedAt: null, neverSynced: true, connectedAt: ago(400) },
        { ...base, provider: "PLAID", kind: "BANK", institution: UNLISTED_INSTITUTION, network: null, status: "NEEDS_REAUTH", healthState: "NEEDS_REAUTH", errorCode: "ITEM_LOGIN_REQUIRED", needsReauth: true, lastSyncedAt: ago(300), neverSynced: false, connectedAt: ago(450) },
        { ...base, provider: "WALLET", kind: "WALLET", institution: null, network: "MULTIPLE", status: "ACTIVE", healthState: "DEGRADED", errorCode: "NO_USED_ADDRESSES", needsReauth: false, lastSyncedAt: ago(30), neverSynced: false, connectedAt: ago(100) },
      ]) && r.records.every((x) => x.kind === "CONNECTION" && /^h_[A-Za-z0-9_-]{16}$/.test(x.handle) && !x.t2Fields), r);
    {
      // S2 09dy(1): each record carrying one of the two address codes holds EXACTLY the closed CONNECTION fields — no
      // extra key, no address, fragment, wallet name or format hint (the fixture rows carry all four beside the code).
      const SCHEMA_KEYS = Object.keys(connectionsPackTools(e0ConnectionsReaders(NOW)).find((x) => x.name === "get_customer_connections")!.recordSchema!.fields).sort().join();
      const coded = r.records.filter((x) => x.fields.errorCode === "INVALID_WALLET_ADDRESS" || x.fields.errorCode === "NO_USED_ADDRESSES");
      check("S2 09dy(1): both address codes are present (non-vacuous), each in a record with exactly the closed field set and a chain CODE network",
        coded.length === 2 && coded.every((x) => Object.keys(x.fields).sort().join() === SCHEMA_KEYS && /^[A-Z]+$/.test(String(x.fields.network))), coded);
      check("S2 09dy(1): NO address / fragment (head or tail) / wallet name / format hint anywhere in the envelope", sentinelHits(r, ADDRESS_BEARING).length === 0, sentinelHits(r, ADDRESS_BEARING));
      // …nor in what a provider request would carry: the boundary's model-facing JSON of this result (what core.ts sends as the tool message).
      const providerMessage = JSON.stringify({ role: "tool", tool_call_id: "c1", content: JSON.stringify(r) });
      check("S2 09dy(1): the provider-request tool message carries the codes but none of the address-bearing values",
        /INVALID_WALLET_ADDRESS/.test(providerMessage) && /NO_USED_ADDRESSES/.test(providerMessage) && sentinelHits(providerMessage, ADDRESS_BEARING).length === 0);
    }
    check("ONE PLATFORM_AI_RECORD_VIEWED row (the owner, deduplicated across the four records), kind CONNECTION",
      rows.length === 1 && rows[0].action === "PLATFORM_AI_RECORD_VIEWED" && rows[0].targetUserId === ZELDA.id && rows[0].detail.recordKind === "CONNECTION" && rows[0].detail.tool === "get_customer_connections");
    check("NO wallet address (or its tail), nickname, wallet / account name, mask, balance, institution name, provider text, email or connection id",
      leaks(r).length === 0 && !/e0-item|e0-conn/.test(JSON.stringify(r)), leaks(r));
    check("another turn's handle ⇒ NOT_FOUND", JSON.stringify(await turn({ correlationId: "corr-x" }).call("get_customer_connections", { customer: handle })) === NF);
    check("a raw user id / guessed handle ⇒ NOT_FOUND", JSON.stringify(await call("get_customer_connections", { customer: ZELDA.id })) === NF
      && JSON.stringify(await call("get_customer_connections", { customer: "h_AAAAAAAAAAAAAAAA" })) === NF);
    const ops = turn({ areas: ["PLATFORM_OPS"] });
    check("a PLATFORM_OPS-only operator ⇒ NOT_FOUND, no audit row", JSON.stringify(await ops.call("get_customer_connections", { customer: handle })) === NF && ops.rows.length === 0);
    const mk = (over: Partial<ConnectionsPackReaders>, fails = false) => {
      const rr: BoundaryAuditRow[] = [];
      const b = createTurnBoundary({
        operatorId: OP, correlationId: "corr-f", areas: [{ scope: scopeFromGuard(authFor("CUSTOMER_SUCCESS"), "CUSTOMER_SUCCESS", OP)!, binding: {} as never }], binding: {} as never,
        recheck: async (a) => ({ auth: authFor(a), csTier: true, incidentToken: TOKEN[a] as never }),
        packs: ["connections"], packEnabled: () => true, registry: connectionsPackTools(e0ConnectionsReaders(NOW, over)) as never,
        recordSources: { CUSTOMER: { t2Fields: [], revalidate: async () => "CUSTOMER_SUCCESS", t1: async () => null, linkedUserIds: async () => [ZELDA.id], t2: async () => null } },
        audit: async (x) => { if (fails) throw new Error("down"); rr.push(...x); },
      });
      return { b, rr };
    };
    const f = mk({}, true);
    const fh = await f.b.adoptSubject({ rk: "CUSTOMER", rid: "u:a1a1a1a1", area: "CUSTOMER_SUCCESS" });
    const fr = await f.b.invoke("get_customer_connections", JSON.stringify({ customer: fh }), { ev: ev(), paramKeys: [], asked: [] }) as unknown as Res;
    check("audit write fails ⇒ UNAVAILABLE, NO record data (fail closed)", fr.status === "UNAVAILABLE" && fr.records.length === 0 && !/user #|h_/.test(JSON.stringify(fr)), fr);
    const nk = mk({ ridOf: () => null });
    const nh = await nk.b.adoptSubject({ rk: "CUSTOMER", rid: "u:a1a1a1a1", area: "CUSTOMER_SUCCESS" });
    const nr = await nk.b.invoke("get_customer_connections", JSON.stringify({ customer: nh }), { ev: ev(), paramKeys: [], asked: [] }) as unknown as Res;
    check("no server key (no keyed customer ref) ⇒ nothing returned, nothing audited", nr.status === "MISSING" && nr.records.length === 0 && nk.rr.length === 0, nr);
    check("CONNECTION_TOOL_NAMES = the pack's tools", CONNECTION_TOOL_NAMES.join() === connectionsPackTools(e0ConnectionsReaders(NOW)).map((x) => x.name).join());
  }

  console.log("\n3. the server reader + CONNECTION record source (fake client)");
  {
    const S = await import("./connections.server");
    const calls: { model: string; args: Record<string, unknown> }[] = [];
    const plaid = [{ id: "pi1", userId: ZELDA.id, institutionId: E0_KNOWN_INSTITUTION_ID, status: "NEEDS_REAUTH", errorCode: "ITEM_LOGIN_REQUIRED", lastSyncedAt: new Date(NOW.getTime() - 3_600_000), createdAt: new Date(NOW.getTime() - 86_400_000) }];
    const conns = [
      { id: "cw1", userId: ZELDA.id, provider: "WALLET", status: "ACTIVE", errorCode: null, lastSyncedAt: new Date(NOW.getTime() - 60_000), createdAt: new Date(NOW.getTime() - 86_400_000), accountConnections: [{ financialAccount: { walletChain: "SOL" } }], _count: { accountConnections: 1 } },
      { id: "cw2", userId: ZELDA.id, provider: "WALLET", status: "ACTIVE", errorCode: null, lastSyncedAt: null, createdAt: new Date(NOW.getTime() - 86_400_000), accountConnections: [], _count: { accountConnections: 2 } },
    ];
    const fake = {
      plaidItem: {
        findMany: async (args: Record<string, unknown>) => { calls.push({ model: "plaidItem", args }); return plaid; },
        findFirst: async (args: Record<string, unknown>) => { calls.push({ model: "plaidItem.first", args }); return (args.where as { id: string }).id === "pi1" ? { userId: ZELDA.id, institutionId: E0_KNOWN_INSTITUTION_ID } : null; },
      },
      connection: {
        findMany: async (args: Record<string, unknown>) => { calls.push({ model: "connection", args }); return conns; },
        findFirst: async (args: Record<string, unknown>) => { calls.push({ model: "connection.first", args }); return (args.where as { id: string }).id === "cw1" ? { userId: ZELDA.id, accountConnections: conns[0].accountConnections } : null; },
      },
      platformSetting: { findMany: async () => [] },
    } as never;
    const out = await S.customerConnections(ZELDA.id, NOW, fake);
    check("reader: Plaid + live wallets; a wallet whose every link is soft-deleted (removed) is skipped; health.ts's verdict; chains only",
      out.rows.length === 2 && out.rows[0].source === "PLAID" && out.rows[0].healthState === "NEEDS_REAUTH" && out.rows[0].institutionId === E0_KNOWN_INSTITUTION_ID
      && out.rows[1].id === "cw1" && out.rows[1].healthState === "HEALTHY" && out.rows[1].chains.join() === "SOL" && out.truncated === false, out);
    const selects = JSON.stringify(calls.filter((c) => c.model === "plaidItem" || c.model === "connection").map((c) => c.args.select));
    check("reader selects are ALLOWLISTED: never institutionName, externalConnectionId, cursor, token, name, mask, balance",
      !/institutionName|externalConnectionId|cursor|encryptedToken|"name"|mask|balance|currentBalance/.test(selects), selects);
    const wheres = JSON.stringify(calls.filter((c) => c.model === "plaidItem" || c.model === "connection").map((c) => c.args.where));
    check("reader population = health.ts's: REVOKED excluded, MANUAL / CSV / PLAID never from Connection", /"not":"REVOKED"/.test(wheres) && /"notIn":\["PLAID","MANUAL","CSV"\]/.test(wheres), wheres);
    const src = S.connectionRecordSource(fake);
    const csGuard = { auth: authFor("CUSTOMER_SUCCESS"), csTier: true } as never;
    const opsGuard = { auth: authFor("PLATFORM_OPS"), csTier: false } as never;
    check("source.revalidate: CUSTOMER_SUCCESS with a fresh CS tier only; an unknown / malformed rid ⇒ null",
      (await src.revalidate("p:pi1", "CUSTOMER_SUCCESS", csGuard)) === "CUSTOMER_SUCCESS" && (await src.revalidate("p:pi1", "PLATFORM_OPS", opsGuard)) === null
      && (await src.revalidate("p:pi1", "CUSTOMER_SUCCESS", { ...(csGuard as object), csTier: false } as never)) === null
      && (await src.revalidate("p:nope", "CUSTOMER_SUCCESS", csGuard)) === null && (await src.revalidate("pi1", "CUSTOMER_SUCCESS", csGuard)) === null);
    const owned = JSON.stringify(calls.filter((c) => c.model.endsWith(".first")).map((c) => c.args));
    check("source reads require a CUSTOMER owner (CUSTOMER_WHERE) and a live row, and select no name / address", /"role":"USER"/.test(owned) && /"not":"REVOKED"/.test(owned) && !/institutionName|externalConnectionId/.test(owned), owned);
    check("source.t1: a code-derived label from the registry (bank ⇒ registry institution; wallet ⇒ registry network)",
      (await src.t1("p:pi1", "CUSTOMER_SUCCESS")) === `bank connection (${KNOWN})` && (await src.t1("c:cw1", "CUSTOMER_SUCCESS")) === "wallet connection (Solana)");
    check("source.linkedUserIds = the owner; t2Fields none; t2 ⇒ null", JSON.stringify(await src.linkedUserIds("c:cw1", "CUSTOMER_SUCCESS")) === JSON.stringify([ZELDA.id])
      && src.t2Fields.length === 0 && (await src.t2("p:pi1", "CUSTOMER_SUCCESS", "name")) === null);
  }

  console.log("\n4. static — the mappers read closed fields only");
  {
    const src = readFileSync(path.join(process.cwd(), "lib/platform/intelligence/ai/tools/packs/connections.ts"), "utf8");
    const body = src.slice(src.indexOf("// ── Mappers"), src.indexOf("// ── The contracts")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const f of ["label", "institutionName", "institution", "externalConnectionId", "name", "nickname", "mask", "balance", "message", "email", "since", "availableActions", "institutionRef", "institutionActive"]) {
      check(`the mappers never read .${f}`, !new RegExp(`\\.${f}\\b`).test(body));
    }
    check("the mappers never spread a reader DTO", !/\.\.\.(r|h|t|f|row|rows)\b/.test(body));
    const server = readFileSync(path.join(process.cwd(), "lib/platform/intelligence/ai/tools/packs/connections.server.ts"), "utf8");
    const serverCode = server.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    check("the fleet aggregate IS health.ts getConnectionHealth; the per-customer verdict IS health.ts deriveConnectionHealthState", /getConnectionHealth\(CONNECTIONS_LIST_CAP\)/.test(serverCode) && /deriveConnectionHealthState\(/.test(serverCode));
    check("the server file selects no institution name / address / balance and never logs", !/institutionName:\s*true|\.institutionName\b|externalConnectionId|Balance|console\./.test(serverCode));
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
