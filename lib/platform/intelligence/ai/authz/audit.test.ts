/**
 * lib/platform/intelligence/ai/authz/audit.test.ts  (Platform AI P5 — the fail-closed audit writer, I-5 / D-5)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/authz/audit.test.ts
 *
 * 1. tool rows: one AuditLog row per row, through recordOperatorAction; actor = the FRESH guard of the
 *    row's area (operator, PLATFORM_GRANT, area); target USER; detail = codes only;
 * 2. fail closed: no fresh guard for the area / break-glass (grant null) / a guard for another area /
 *    a malformed row ⇒ throws BEFORE any write (a whole batch writes nothing); a client failure throws;
 * 3. render rows: only PLATFORM_AI_RECORD_VIEWED is accepted;
 * 4. subject rows: target USER when matched, else PLATFORM_AI_SUBJECT = keyHash; detail {surface,
 *    idKind, outcome, keyHash}; result SUCCESS / REFUSED; a bad keyHash ⇒ throws;
 * 5. end-to-end through the REAL boundary: a customer-linkable RECORD tool whose audit client fails
 *    ⇒ UNAVAILABLE with no record data (AUDIT_FAILURE_UNAVAILABLE); a working client ⇒ rows first.
 */

import { UserRole, type PlatformArea } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import { PlatformAiAuditRefused, platformAiRenderAudit, platformAiSubjectAudit, platformAiToolAudit } from "./audit";
import type { FreshGuard } from "./recheck";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const OP = "cop000000000000000000000cs";
const CUST = "ccustomer0000000000000001";
const guard = (area: PlatformArea, over: Partial<{ id: string; grantArea: PlatformArea | null }> = {}): FreshGuard => ({
  auth: { user: { id: over.id ?? OP, role: UserRole.USER }, grant: over.grantArea === null ? null : { area: over.grantArea ?? area, level: "READ" } },
  csTier: area === "CUSTOMER_SUCCESS",
});
function client(fail = false) {
  const rows: Record<string, unknown>[] = [];
  return { rows, c: { auditLog: { create: async (a: { data: Record<string, unknown> }) => { if (fail) throw new Error("db down"); rows.push(a.data); return { id: `a${rows.length}` }; } } } };
}
const row = (over: Partial<{ area: PlatformArea; targetUserId: string; tool: string }> = {}) => ({
  action: AuditAction.PLATFORM_AI_RECORD_VIEWED, area: over.area ?? ("CUSTOMER_SUCCESS" as PlatformArea), targetUserId: over.targetUserId ?? CUST,
  detail: { surface: "platform-ai" as const, tool: over.tool ?? "list_customer_attention", recordKind: "CUSTOMER" },
});
const throwsCode = async (p: Promise<unknown>, code: string) => { try { await p; return false; } catch (e) { return e instanceof PlatformAiAuditRefused ? e.code === code : code === "*"; } };

async function main() {
  console.log("1. tool rows");
  {
    const k = client();
    await platformAiToolAudit(k.c)([row(), row({ targetUserId: "ccustomer0000000000000002" })], new Map([["CUSTOMER_SUCCESS", guard("CUSTOMER_SUCCESS")]]));
    const m = k.rows[0]?.metadata as Record<string, unknown>;
    check("one row per row, through the chokepoint: userId = the customer, performedByAdminId = the operator, action as declared",
      k.rows.length === 2 && k.rows[0].userId === CUST && k.rows[0].performedByAdminId === OP && k.rows[0].action === "PLATFORM_AI_RECORD_VIEWED", k.rows);
    check("actor = PLATFORM_GRANT for the row's area; target USER; detail = surface / tool / recordKind codes only",
      (m.actor as { via: string; area: string }).via === "PLATFORM_GRANT" && (m.actor as { area: string }).area === "CUSTOMER_SUCCESS"
      && (m.target as { kind: string }).kind === "USER" && m.surface === "platform-ai" && m.tool === "list_customer_attention" && m.recordKind === "CUSTOMER"
      && Object.keys(m).sort().join() === "actor,actorType,recordKind,result,surface,target,tool", m);
  }

  console.log("\n2. fail closed — before any write");
  {
    const cases: [string, Promise<unknown>, string, ReturnType<typeof client>][] = [];
    const mk = (label: string, rows: ReturnType<typeof row>[], guards: Map<PlatformArea, FreshGuard>, code: string) => {
      const k = client();
      cases.push([label, platformAiToolAudit(k.c)(rows, guards), code, k]);
    };
    mk("no fresh guard for the row's area", [row()], new Map(), "NO_FRESH_GUARD");
    mk("break-glass guard (grant null)", [row()], new Map([["CUSTOMER_SUCCESS", guard("CUSTOMER_SUCCESS", { grantArea: null })]]), "BREAK_GLASS");
    mk("a guard whose grant is for another area", [row()], new Map([["CUSTOMER_SUCCESS", guard("CUSTOMER_SUCCESS", { grantArea: "PLATFORM_OPS" })]]), "BREAK_GLASS");
    mk("a malformed row (target not an id)", [row({ targetUserId: "zelda@x.invalid" })], new Map([["CUSTOMER_SUCCESS", guard("CUSTOMER_SUCCESS")]]), "ROW_INVALID");
    mk("one bad row in a batch ⇒ the WHOLE batch writes nothing", [row(), row({ area: "PLATFORM_OPS" })], new Map([["CUSTOMER_SUCCESS", guard("CUSTOMER_SUCCESS")]]), "NO_FRESH_GUARD");
    for (const [label, p, code, k] of cases) check(`${label} ⇒ refused (${code}), 0 rows written`, (await throwsCode(p, code)) && k.rows.length === 0);
    const down = client(true);
    check("a client write failure throws (the caller withholds the data)", await throwsCode(platformAiToolAudit(down.c)([row()], new Map([["CUSTOMER_SUCCESS", guard("CUSTOMER_SUCCESS")]])), "*"));
  }

  console.log("\n3. render rows");
  {
    const k = client();
    await platformAiRenderAudit(k.c)([{ ...row(), detail: { surface: "platform-ai", tool: "record-render", recordKind: "CUSTOMER" } }], new Map([["CUSTOMER_SUCCESS", guard("CUSTOMER_SUCCESS")]]));
    check("PLATFORM_AI_RECORD_VIEWED written with tool record-render", k.rows.length === 1 && (k.rows[0].metadata as { tool: string }).tool === "record-render");
    const k2 = client();
    const other = { ...row(), action: AuditAction.CUSTOMER_PROFILE_VIEWED, detail: { surface: "platform-ai" as const, tool: "record-render" as const, recordKind: "CUSTOMER" } };
    check("any other action ⇒ refused, nothing written", (await throwsCode(platformAiRenderAudit(k2.c)([other], new Map([["CUSTOMER_SUCCESS", guard("CUSTOMER_SUCCESS")]])), "ROW_INVALID")) && k2.rows.length === 0);
  }

  console.log("\n4. subject rows");
  {
    const k = client();
    const w = platformAiSubjectAudit(k.c);
    await w({ actor: { operatorId: OP, area: "CUSTOMER_SUCCESS" }, idKind: "EMAIL", outcome: "MATCHED", keyHash: "0badc0de", matchedUserId: CUST });
    await w({ actor: { operatorId: OP, area: "PLATFORM_OPS" }, idKind: "USER_ID", outcome: "NO_ACCESS", keyHash: "12ab34cd", matchedUserId: null });
    const [a, b] = k.rows;
    const ma = a.metadata as Record<string, unknown>, mb = b.metadata as Record<string, unknown>;
    check("matched ⇒ target USER (userId set), result SUCCESS", a.userId === CUST && (ma.target as { kind: string }).kind === "USER" && ma.result === "SUCCESS" && a.action === "PLATFORM_AI_SUBJECT_LOOKUP");
    check("not matched ⇒ target PLATFORM_AI_SUBJECT = the keyed hash, no userId, result REFUSED",
      b.userId === undefined && (mb.target as { kind: string; id: string }).kind === "PLATFORM_AI_SUBJECT" && (mb.target as { id: string }).id === "12ab34cd" && mb.result === "REFUSED");
    check("detail = surface / idKind / outcome / keyHash only (never the identifier)",
      ma.surface === "platform-ai" && ma.idKind === "EMAIL" && ma.outcome === "MATCHED" && ma.keyHash === "0badc0de" && !JSON.stringify(k.rows).includes("@"));
    const bad = client();
    check("a keyHash that is not 8 hex (e.g. the raw identifier) ⇒ refused, nothing written",
      (await throwsCode(platformAiSubjectAudit(bad.c)({ actor: { operatorId: OP, area: "CUSTOMER_SUCCESS" }, idKind: "EMAIL", outcome: "NOT_FOUND", keyHash: "zelda@x.invalid", matchedUserId: null }), "ROW_INVALID")) && bad.rows.length === 0);
  }

  console.log("\n5. end to end through the real boundary (customers-pack shape)");
  {
    const { createTurnBoundary } = await import("./boundary");
    const { scopeFromGuard } = await import("./scope");
    const { customersPackTools } = await import("../tools/packs/customers");
    const auth = { user: { id: OP, role: UserRole.USER }, grant: { area: "CUSTOMER_SUCCESS" as const, level: "READ" as const } };
    const scope = scopeFromGuard(auth, "CUSTOMER_SUCCESS", OP)!;
    const token = { audience: "CUSTOMER_SUCCESS" } as never;
    // attentionOf reads fold.sets per key: the customer has one reason.
    const fold = { union: new Set([CUST]), sets: { reconnect: new Set([CUST]) }, keys: ["reconnect"], floor: false, testAccounts: new Set<string>(), details: new Map() };
    const readers = {
      attention: async () => ({ fold: fold as never }),
      recentlyJoined: async () => ({ windowDays: 14, total: 0, rows: [], importTotals: {} as never, floor: false }),
      profile: async () => null, ridOf: () => "u:3fa9c21b", resolveRid: async () => CUST, now: () => new Date("2026-11-10T00:00:00Z"),
    };
    const tools = customersPackTools(readers as never);
    const run = async (writerClient: ReturnType<typeof client>) => {
      const b = createTurnBoundary({
        operatorId: OP, correlationId: "corr-audit", areas: [{ scope, binding: {} as never }], binding: {} as never,
        recheck: async () => ({ auth, csTier: true, incidentToken: token }), packs: ["customers"], packEnabled: () => true,
        registry: tools as never, audit: platformAiToolAudit(writerClient.c),
      });
      return b.invoke("list_customer_attention", "{}", { ev: { envelopes: [], hrefs: new Set(), definitions: [], labels: new Set(), trace: [], pages: new Map() }, paramKeys: [], asked: [] });
    };
    const ok = client();
    const res = await run(ok) as { status: string; records: { handle: string; fields: Record<string, unknown> }[] };
    check("working writer: the row is written, then the record leaves (handle, opaque ref, reason code — no user id)",
      ok.rows.length === 1 && ok.rows[0].userId === CUST && res.status === "CONFIRMED" && res.records.length === 1
      && res.records[0].fields.ref === "user #3fa9c21b" && res.records[0].fields.reason === "reconnect" && !JSON.stringify(res).includes(CUST), res);
    const down = client(true);
    const res2 = await run(down) as { status: string; records: unknown[] };
    check("AUDIT_FAILURE_UNAVAILABLE: a failing writer ⇒ UNAVAILABLE, NO record data", res2.status === "UNAVAILABLE" && res2.records.length === 0 && !JSON.stringify(res2).includes("3fa9c21b"), res2);
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
