/**
 * lib/connections/add-failure.test.ts  (B12 PR-B — the CONNECTION_ADD_FAILED writer, pure parts)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/connections/add-failure.test.ts
 *
 * The classifier returns only allowlisted codes; the row carries exactly
 * {actorType, result, provider, stage, errorCode}; a provider / stage pair
 * outside the vocabulary writes nothing; the writer never throws.
 * The three routes are exercised for real in app/api/connection-add-failure.test.ts.
 */

import { Prisma } from "@prisma/client";
import {
  CONNECTION_ADD_FAILURE_CODES, connectionAddFailureCode, connectionAddFailureData, recordConnectionAddFailure,
  type AddFailureClient, type ConnectionAddFailureInput,
} from "./add-failure";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const axiosLike = (code?: string) => ({ response: { status: 400, data: { error_code: code, error_message: "Example Bank: secret" } } });

async function main() {
  console.log("1. classifier — allowlisted codes only");
  check("a known Plaid code passes", connectionAddFailureCode(axiosLike(), "INSTITUTION_DOWN") === "INSTITUTION_DOWN");
  check("the raw response code is the fallback input", connectionAddFailureCode(axiosLike("ITEM_LOCKED")) === "ITEM_LOCKED");
  check("an unknown code ⇒ OTHER (never itself)", connectionAddFailureCode(axiosLike("Example Bank: secret")) === "OTHER");
  check("lower-case known code is normalised", connectionAddFailureCode(null, "institution_down") === "INSTITUTION_DOWN");
  check("a 'NONE' provider code is not a cause ⇒ OTHER", connectionAddFailureCode(null, "NONE") === "OTHER");
  check("HTTP error without a code ⇒ PROVIDER_HTTP_ERROR", connectionAddFailureCode(axiosLike()) === "PROVIDER_HTTP_ERROR");
  check("SyntaxError ⇒ INVALID_BODY", connectionAddFailureCode(new SyntaxError("Unexpected token")) === "INVALID_BODY");
  check("Prisma error ⇒ DATABASE_ERROR", connectionAddFailureCode(new Prisma.PrismaClientKnownRequestError("x", { code: "P1001", clientVersion: "x" })) === "DATABASE_ERROR");
  check("missing secret ⇒ SERVER_CONFIGURATION", connectionAddFailureCode(new Error("Missing env var: PLAID_SECRET")) === "SERVER_CONFIGURATION");
  check("anything else ⇒ UNEXPECTED", connectionAddFailureCode(new Error("boom")) === "UNEXPECTED" && connectionAddFailureCode("str") === "UNEXPECTED");
  const samples = [axiosLike("X"), axiosLike(), new Error("e"), null, undefined, 42, new SyntaxError("s")];
  check("every classification is in CONNECTION_ADD_FAILURE_CODES", samples.every((e) => CONNECTION_ADD_FAILURE_CODES.includes(connectionAddFailureCode(e))));
  check("the vocabulary has no NONE and every code is short upper-snake",
    !CONNECTION_ADD_FAILURE_CODES.includes("NONE") && CONNECTION_ADD_FAILURE_CODES.every((c) => /^[A-Z_]{1,64}$/.test(c)));

  console.log("2. the row");
  const ok: ConnectionAddFailureInput = { userId: "u1", provider: "PLAID", stage: "EXCHANGE", errorCode: "INSTITUTION_DOWN" };
  const d = connectionAddFailureData(ok)!;
  check("action CONNECTION_ADD_FAILED, user, no request forensics", d.action === "CONNECTION_ADD_FAILED" && d.userId === "u1" && d.ipAddress === null && d.userAgent === null && !("spaceId" in d));
  check("metadata is exactly the five keys", JSON.stringify(Object.keys(d.metadata as object).sort()) === JSON.stringify(["actorType", "errorCode", "provider", "result", "stage"]));
  check("result FAILURE", (d.metadata as Record<string, unknown>).result === "FAILURE");
  check("a code outside the vocabulary is stored as OTHER",
    (connectionAddFailureData({ ...ok, errorCode: "Example Bank: secret" })!.metadata as Record<string, unknown>).errorCode === "OTHER");
  check("mismatched provider / stage writes nothing",
    connectionAddFailureData({ ...ok, provider: "WALLET" }) === null && connectionAddFailureData({ ...ok, provider: "PLAID", stage: "WALLET_ADD" }) === null);
  check("unknown provider / stage / empty user writes nothing",
    connectionAddFailureData({ ...ok, provider: "EXAMPLE_EXCHANGE" as never }) === null
    && connectionAddFailureData({ ...ok, stage: "OTHER" as never }) === null
    && connectionAddFailureData({ ...ok, userId: "" }) === null);

  console.log("3. the writer — best-effort, never throws");
  const created: unknown[] = [];
  const client: AddFailureClient = { auditLog: { create: async (a) => { created.push(a.data); return {}; } } };
  check("writes one row in the user's tenant phase", await recordConnectionAddFailure(ok, { withTenant: (_u, fn) => fn(client) }) === true && created.length === 1);
  check("a throwing phase resolves false", await recordConnectionAddFailure(ok, { withTenant: async () => { throw new Error("db down"); } }) === false);
  check("a throwing create resolves false",
    await recordConnectionAddFailure(ok, { withTenant: (_u, fn) => fn({ auditLog: { create: () => { throw new Error("x"); } } }) }) === false);
  const before = created.length;
  check("an out-of-vocabulary input writes nothing and resolves false",
    await recordConnectionAddFailure({ ...ok, stage: "WALLET_ADD" }, { withTenant: (_u, fn) => fn(client) }) === false && created.length === before);

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
