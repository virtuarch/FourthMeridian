/**
 * lib/platform/intelligence/ai/tools/packs/onboarding.test.ts  (Platform AI P6 — the onboarding pack, I-3 / I-5 / D-3 / S2 09dx)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/tools/packs/onboarding.test.ts
 *
 * Through the REAL turn boundary (authz/boundary.ts) over the E0 reader fixtures (sentinel T2 + an injection
 * payload in every free-text field — eval/fixtures.ts e0OnboardingDtos):
 * 1. onboarding_overview: Ops-only ⇒ the identity-free import counts and needsHelp null; with a fresh CS guard ⇒
 *    the needs-help counts per onboarding reason, link / add-failure CODE counts (unknown ⇒ OTHER), stages and the
 *    code-written next steps; an injected reason key ⇒ UNKNOWN; a failed reader ⇒ UNAVAILABLE; no sentinel;
 * 2. list_onboarding_attention: the oracle's closed fields per customer (reason, time, codes), one
 *    PLATFORM_AI_RECORD_VIEWED row per customer, reason filter, Ops ⇒ NOT_FOUND, audit failure ⇒ UNAVAILABLE,
 *    no server key ⇒ no record;
 * 3. get_onboarding_timeline: the oracle's closed fields by THIS turn's handle; another turn's handle ⇒ NOT_FOUND;
 * 4. static: the mappers read no label / institution / message / detail / pending / event field.
 */

process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "onboarding-pack-test-secret-not-real";

import { readFileSync } from "node:fs";
import path from "node:path";
import { UserRole, type PlatformArea } from "@prisma/client";
import { E0_CUSTOMERS, E0_INJECTION_SENTINELS, E0_T2_SENTINELS, e0OnboardingReaders } from "../../eval/fixtures";
import type { BoundaryAuditRow } from "../../authz/boundary";
import type { OnboardingPackReaders } from "./onboarding";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 900)}` : ""}`); }
}

const OP = "cop000000000000000000000on";
const NOW = new Date("2026-11-10T12:00:00.000Z");
const [ZELDA, ORRIN] = E0_CUSTOMERS;
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const leaks = (x: unknown) => {
  const s = JSON.stringify(x).toLowerCase();
  return [...E0_T2_SENTINELS, ...E0_INJECTION_SENTINELS, "e0inj"].filter((v) => s.includes(v.toLowerCase()));
};

async function main() {
  const { createTurnBoundary } = await import("../../authz/boundary");
  const { scopeFromGuard } = await import("../../authz/scope");
  const { onboardingPackTools, ONBOARDING_TOOL_NAMES } = await import("./onboarding");
  const { ATTENTION_ACTIONS } = await import("@/lib/platform/customer/attention-core");
  const { FUNNEL_STAGE_ORDER } = await import("@/lib/platform/growth/product-analytics-core");
  const authFor = (area: PlatformArea) => ({ user: { id: OP, role: UserRole.USER }, grant: { area, level: "READ" as const } });
  const TOKEN: Record<string, unknown> = { CUSTOMER_SUCCESS: { audience: "CUSTOMER_SUCCESS" }, PLATFORM_OPS: { audience: "PLATFORM_OPS" } };
  const ev = () => ({ envelopes: [], hrefs: new Set<string>(), definitions: [], labels: new Set<string>(), trace: [], pages: new Map() });

  function turn(opts: { areas?: PlatformArea[]; readers?: OnboardingPackReaders; flag?: boolean; correlationId?: string; auditFails?: boolean; noAudit?: boolean } = {}) {
    const areas = opts.areas ?? ["CUSTOMER_SUCCESS"];
    const rows: BoundaryAuditRow[] = [];
    const b = createTurnBoundary({
      operatorId: OP, correlationId: opts.correlationId ?? "corr-1",
      areas: areas.map((a) => ({ scope: scopeFromGuard(authFor(a), a, OP)!, binding: {} as never })), binding: {} as never,
      recheck: async (a) => ({ auth: authFor(a), csTier: a === "CUSTOMER_SUCCESS", incidentToken: TOKEN[a] as never }),
      packs: ["onboarding"], packEnabled: () => opts.flag ?? true,
      registry: onboardingPackTools(opts.readers ?? e0OnboardingReaders(NOW)) as never,
      ...(opts.noAudit ? {} : { audit: async (r: readonly BoundaryAuditRow[]) => { if (opts.auditFails) throw new Error("down"); rows.push(...r); } }),
    });
    const call = (name: string, args: unknown) => b.invoke(name, JSON.stringify(args), { ev: ev(), paramKeys: [], asked: [] }) as Promise<Record<string, unknown>>;
    return { b, rows, call };
  }
  type Res = { status: string; truncated: boolean; records: { handle: string; kind: string; fields: Record<string, unknown>; t2Fields?: string[] }[] };
  const NF = JSON.stringify({ found: false });

  console.log("1. onboarding_overview (AGGREGATE, counts only)");
  {
    const ops = turn({ areas: ["PLATFORM_OPS"] });
    const o = await ops.call("onboarding_overview", {}) as Record<string, unknown>;
    check("Ops-only: the identity-free import counts; an injected failed-reason KEY ⇒ UNKNOWN; needsHelp null (no CS guard)",
      o.status === "CONFIRMED" && JSON.stringify(o.imports) === JSON.stringify({
        windowDays: 7, started: 3, byStatus: { in_progress: 1, complete: 1, recovered: 0, failed: 1, removed: 0 },
        failedReasons: { PROVIDER_AUTH: 1, UNKNOWN: 2 }, interruptedInProgress: 1, floor: false,
      }) && o.needsHelp === null, o);
    check("Ops-only: no audit row, no record, no sentinel / injection", ops.rows.length === 0 && !("records" in o) && leaks(o).length === 0, leaks(o));
    const both = turn({ areas: ["PLATFORM_OPS", "CUSTOMER_SUCCESS"] });
    const c = await both.call("onboarding_overview", {}) as { needsHelp?: Record<string, unknown> };
    const stages = Object.fromEntries(FUNNEL_STAGE_ORDER.map((k, i) => [k, i === 0 || i === 2 ? 1 : 0]));
    check("with a fresh CS guard: needsHelp per ONBOARDING reason (reconnect is not one), link codes (unknown ⇒ OTHER), stages, test accounts",
      JSON.stringify(c.needsHelp && { ...c.needsHelp, nextSteps: undefined }) === JSON.stringify({
        customers: 2, byReason: { import_failed: 1, import_stuck: 0, link_exited: 1, link_failed: 1, no_connection_24h: 0, stalled: 1 }, testAccounts: 1,
        linkExitCodes: { INVALID_CREDENTIALS: 1 }, addFailureCodes: { OTHER: 1 }, addFailureStages: { WALLET_ADD: 1 }, stages, floor: false, nextSteps: undefined,
      }), c.needsHelp);
    const steps = (c.needsHelp?.nextSteps ?? {}) as Record<string, string>;
    check("nextSteps: the code-written ATTENTION_ACTIONS text for exactly the reasons that apply (nothing contacts a customer)",
      Object.keys(steps).join() === "import_failed,link_exited,link_failed,stalled" && Object.entries(steps).every(([k, v]) => v === ATTENTION_ACTIONS[k as keyof typeof ATTENTION_ACTIONS]));
    check("CS overview: no sentinel / injection, no audit row (counts carry no linkage)", leaks(c).length === 0 && both.rows.length === 0, leaks(c));
    const broken = turn({ areas: ["PLATFORM_OPS"], readers: e0OnboardingReaders(NOW, { newConnectionImports: async () => { throw new Error("db down"); } }) });
    const u = await broken.call("onboarding_overview", {}) as Record<string, unknown>;
    check("a failed reader ⇒ UNAVAILABLE with no figures", u.status === "UNAVAILABLE" && !("imports" in u) && !("needsHelp" in u), u);
    check("an argument ⇒ NOT_FOUND (closed, empty schema)", JSON.stringify(await ops.call("onboarding_overview", { reason: "stalled" })) === NF);
    check("flag OFF ⇒ NOT_FOUND", JSON.stringify(await turn({ areas: ["PLATFORM_OPS"], flag: false }).call("onboarding_overview", {})) === NF);
  }

  console.log("\n2. list_onboarding_attention (CS-tier RECORD, audited)");
  let zeldaHandle = "";
  {
    const t = turn();
    const r = await t.call("list_onboarding_attention", {}) as unknown as Res;
    check("records: primary ONBOARDING reason (display order), time, closed codes; an unknown add-failure code ⇒ OTHER; handles + t2Fields names only",
      r.status === "CONFIRMED" && r.truncated === false && JSON.stringify(r.records.map((x) => x.fields)) === JSON.stringify([
        { ref: "user #a1a1a1a1", reason: "import_failed", reasonAt: null, registeredAt: ago(60 * 24 * 3), linkErrorCode: null, addFailureStage: null, importReason: "PROVIDER_AUTH", otherReasons: 2, testAccount: false },
        { ref: "user #b2b2b2b2", reason: "link_failed", reasonAt: ago(60), registeredAt: ago(60 * 24 * 9), linkErrorCode: "OTHER", addFailureStage: "WALLET_ADD", importReason: null, otherReasons: 1, testAccount: true },
      ]) && r.records.every((x) => x.kind === "CUSTOMER" && /^h_[A-Za-z0-9_-]{16}$/.test(x.handle) && x.t2Fields?.join() === "name,email"), r);
    zeldaHandle = r.records[0]?.handle ?? "";
    check("one PLATFORM_AI_RECORD_VIEWED row per customer returned (CUSTOMER_SUCCESS, kind CUSTOMER)",
      t.rows.length === 2 && t.rows.every((x) => x.action === "PLATFORM_AI_RECORD_VIEWED" && x.area === "CUSTOMER_SUCCESS" && x.detail.recordKind === "CUSTOMER" && x.detail.tool === "list_onboarding_attention")
      && t.rows.map((x) => x.targetUserId).sort().join() === [ZELDA.id, ORRIN.id].sort().join());
    check("NO sentinel (email, name, user id) or injection payload (details, stage, codes) in the result", leaks(r).length === 0, leaks(r));
    const ex = await t.call("list_onboarding_attention", { reason: "link_exited" }) as unknown as Res;
    check("reason filter link_exited ⇒ the LATEST exit in the window with its closed code (an older injected code never surfaces)",
      ex.records.length === 1 && JSON.stringify(ex.records[0].fields) === JSON.stringify({
        ref: "user #a1a1a1a1", reason: "link_exited", reasonAt: ago(120), registeredAt: ago(60 * 24 * 3), linkErrorCode: "INVALID_CREDENTIALS", addFailureStage: null, importReason: null, otherReasons: 2, testAccount: false,
      }), ex);
    const st = await t.call("list_onboarding_attention", { reason: "stalled" }) as unknown as Res;
    check("stalled ⇒ reasonAt = registration", st.records.length === 1 && st.records[0].fields.reasonAt === ago(60 * 24 * 9));
    const none = await t.call("list_onboarding_attention", { reason: "no_connection_24h" }) as unknown as Res;
    check("a reason with nobody ⇒ MISSING, no records", none.status === "MISSING" && none.records.length === 0);
    for (const bad of ["reconnect", "policy", "zelda", ZELDA.email]) check(`a non-onboarding / free-text reason (${bad === ZELDA.email ? "email" : bad}) ⇒ NOT_FOUND`, JSON.stringify(await t.call("list_onboarding_attention", { reason: bad })) === NF);
    const ops = turn({ areas: ["PLATFORM_OPS"] });
    check("a PLATFORM_OPS-only operator ⇒ NOT_FOUND, no audit row", JSON.stringify(await ops.call("list_onboarding_attention", {})) === NF && ops.rows.length === 0);
    const fail = turn({ auditFails: true });
    const f = await fail.call("list_onboarding_attention", {}) as unknown as Res;
    check("audit write fails ⇒ UNAVAILABLE, NO record data (fail closed)", f.status === "UNAVAILABLE" && f.records.length === 0 && !/user #|h_/.test(JSON.stringify(f)), f);
    const noWriter = await turn({ noAudit: true }).call("list_onboarding_attention", {}) as unknown as Res;
    check("no audit writer at all ⇒ UNAVAILABLE", noWriter.status === "UNAVAILABLE" && noWriter.records.length === 0);
    const noKey = await turn({ readers: e0OnboardingReaders(NOW, { ridOf: () => null }) }).call("list_onboarding_attention", {}) as unknown as Res;
    check("no server key (no keyed ref) ⇒ no record returned (never a raw id)", noKey.status === "MISSING" && noKey.records.length === 0);
  }

  console.log("\n3. get_onboarding_timeline (CS-tier RECORD by handle)");
  {
    const t = turn({ correlationId: "corr-3" });
    const list = await t.call("list_onboarding_attention", {}) as unknown as Res;
    const h = list.records[0].handle;
    const before = t.rows.length;
    const tl = await t.call("get_onboarding_timeline", { customer: h }) as unknown as Res;
    check("the oracle's closed fields (counts by import status, first times, stage, last failure category)",
      tl.status === "CONFIRMED" && tl.records.length === 1 && JSON.stringify(tl.records[0].fields) === JSON.stringify({
        ref: "user #a1a1a1a1", registeredAt: ago(60 * 24 * 3), invited: true, verifiedAt: ago(60 * 24 * 3 - 5), firstSessionAt: ago(60 * 24 * 3 - 10),
        stage: "firstConnection", bankConnections: 2, walletConnections: 1, firstConnectedAt: ago(60 * 30),
        importsInProgress: 0, importsComplete: 1, importsRecovered: 0, importsFailed: 1, importsRemoved: 0, importsInterrupted: 0,
        lastImportFailure: "PROVIDER_AUTH", importHealth: "red", firstWealthRegenAt: ago(60 * 30 - 10), firstAiTurnAt: null, firstBriefAt: ago(60 * 24), floor: false,
      }), tl);
    check("one PLATFORM_AI_RECORD_VIEWED row for the customer", t.rows.length === before + 1 && t.rows[before].targetUserId === ZELDA.id && t.rows[before].detail.tool === "get_onboarding_timeline");
    check("NO sentinel or injection (connection labels, reason labels, event labels, pending lines)", leaks(tl).length === 0, leaks(tl));
    check("another turn's handle ⇒ NOT_FOUND", JSON.stringify(await turn({ correlationId: "corr-other" }).call("get_onboarding_timeline", { customer: zeldaHandle })) === NF);
    check("a raw user id / guessed handle ⇒ NOT_FOUND", JSON.stringify(await t.call("get_onboarding_timeline", { customer: ZELDA.id })) === NF
      && JSON.stringify(await t.call("get_onboarding_timeline", { customer: "h_AAAAAAAAAAAAAAAA" })) === NF);
    const gone = turn({ correlationId: "corr-4", readers: e0OnboardingReaders(NOW) });
    const l2 = await gone.call("list_onboarding_attention", { reason: "link_failed" }) as unknown as Res;
    const orrinTl = await gone.call("get_onboarding_timeline", { customer: l2.records[0].handle }) as unknown as Res;
    check("a customer with no timeline ⇒ MISSING (never an invented record)", orrinTl.status === "MISSING" && orrinTl.records.length === 0);
    check("trace: codes and counts only", t.b.trace().every((x) => /^[a-z_]+$/.test(x.tool) && /^[A-Z_]+$/.test(x.outcome)) && leaks(t.b.trace()).length === 0);
    check("ONBOARDING_TOOL_NAMES = the pack's tools", ONBOARDING_TOOL_NAMES.join() === onboardingPackTools(e0OnboardingReaders(NOW)).map((x) => x.name).join());
  }

  console.log("\n4. static — the mappers read closed fields only");
  {
    const src = readFileSync(path.join(process.cwd(), "lib/platform/intelligence/ai/tools/packs/onboarding.ts"), "utf8");
    const body = src.slice(src.indexOf("// ── Mappers"), src.indexOf("// ── The contracts"))
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const f of ["label", "reasonLabel", "institutionName", "institution", "pending", "events", "details", "notes", "email", "name", "message", "connectionId"]) {
      check(`the mappers never read .${f}`, !new RegExp(`\\.${f}\\b`).test(body));
    }
    check("the mappers never spread a reader DTO", !/\.\.\.(o|t|r|read|fold|facts|nci|imp)\b/.test(body));
    const server = readFileSync(path.join(process.cwd(), "lib/platform/intelligence/ai/tools/packs/onboarding.server.ts"), "utf8");
    check("the Production readers are the EXISTING ones (no new query)", /getNewConnectionImports\(/.test(server) && /loadAttention\(/.test(server) && /getCustomerDetail\(/.test(server) && !/\.findMany\(|\.findFirst\(|\.findUnique\(|\$queryRaw/.test(server));
    check("the server readers mint nothing (token TYPES only) and never log", !/incidentAudienceFor\(|console\./.test(server));
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
