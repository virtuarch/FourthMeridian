/**
 * lib/plaid/provider-call.test.ts  (DF-2D)
 *
 * Pure guards for provider-call attribution. Standalone tsx script (house
 * pattern): npx tsx <this> — exits 0/1. NO live DB, NO Plaid: an injected
 * `record` collects attempts, and `call` fakes the provider response/error.
 *
 * Covers: success records one SUCCEEDED attempt with request_id + operation +
 * endpoint + attempt · failure records FAILED with Plaid's error_code and
 * RE-THROWS the original error · rate-limit → RATE_LIMITED · retries produce
 * distinct immutable attempts (1, 2) · pagination increments attempt per call ·
 * only allowlisted fields are persisted (no token/secret/payload) · a throwing
 * telemetry write never turns a successful provider call into a failure ·
 * recordProviderCall swallows a write-client failure.
 */

import {
  instrumentProviderCall,
  recordProviderCall,
  extractPlaidRequestId,
  classifyProviderCallError,
  type ProviderCallInput,
  type ProviderCallWriteClient,
} from "@/lib/plaid/provider-call";
import type { ProviderCallContext } from "@/lib/plaid/provider-call-context";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

function ctxOf(over: Partial<ProviderCallContext> = {}): ProviderCallContext {
  return { refreshExecutionId: "exec-1", currentEndpoint: "TRANSACTIONS", attempts: new Map(), ...over };
}
function collector() {
  const rows: ProviderCallInput[] = [];
  return { rows, record: (i: ProviderCallInput) => { rows.push(i); } };
}

// A Plaid-shaped success response and Axios-shaped errors (safe subsets only).
const okRes = { data: { request_id: "req_abc123", accounts: [{ balances: {} }] } };
const failErr = { response: { status: 400, data: { request_id: "req_fail", error_code: "ITEM_LOGIN_REQUIRED", error_type: "ITEM_ERROR", access_token: "access-sandbox-SECRET" } } };
const rateErr = { response: { status: 429, data: { request_id: "req_rl", error_code: "RATE_LIMIT_EXCEEDED", error_type: "RATE_LIMIT_EXCEEDED" } } };

async function main() {
  // Extractors
  check("extractPlaidRequestId reads data.request_id", extractPlaidRequestId(okRes) === "req_abc123");
  check("extractPlaidRequestId undefined when absent", extractPlaidRequestId({ data: {} }) === undefined && extractPlaidRequestId(null) === undefined);
  {
    const f = classifyProviderCallError(failErr);
    check("classify: FAILED with Plaid error_code + http status + request_id", f.status === "FAILED" && f.errorCode === "ITEM_LOGIN_REQUIRED" && f.httpStatus === 400 && f.errorCategory === "ITEM_ERROR" && f.providerRequestId === "req_fail");
    const r = classifyProviderCallError(rateErr);
    check("classify: 429 / RATE_LIMIT_EXCEEDED → RATE_LIMITED", r.status === "RATE_LIMITED");
    check("classify: never surfaces the access token", !JSON.stringify(f).includes("SECRET"));
  }

  // Success lifecycle
  {
    const { rows, record } = collector();
    const ctx = ctxOf();
    const res = await instrumentProviderCall("accountsGet", ctx, async () => okRes, { record });
    check("success: returns the provider result unchanged", res === okRes);
    check("success: one SUCCEEDED attempt recorded", rows.length === 1 && rows[0].status === "SUCCEEDED");
    check("success: operation + endpoint + provider + attempt", rows[0].operation === "accountsGet" && rows[0].endpoint === "TRANSACTIONS" && rows[0].provider === "PLAID" && rows[0].attempt === 1);
    check("success: request_id captured, duration present", rows[0].providerRequestId === "req_abc123" && typeof rows[0].durationMs === "number");
  }

  // Failure lifecycle — records FAILED, rethrows original
  {
    const { rows, record } = collector();
    let thrown: unknown;
    try { await instrumentProviderCall("investmentsHoldingsGet", ctxOf(), async () => { throw failErr; }, { record }); }
    catch (e) { thrown = e; }
    check("failure: original error rethrown unchanged", thrown === failErr);
    check("failure: one FAILED attempt with Plaid error_code", rows.length === 1 && rows[0].status === "FAILED" && rows[0].errorCode === "ITEM_LOGIN_REQUIRED");
    check("data minimization: no token/secret/payload in the record", !JSON.stringify(rows[0]).includes("SECRET") && !("access_token" in rows[0]) && !("data" in rows[0]));
  }

  // Retry — the SAME context/op → two DISTINCT immutable attempts (1 fail, 2 ok).
  {
    const { rows, record } = collector();
    const ctx = ctxOf({ currentEndpoint: "HOLDINGS" });
    try { await instrumentProviderCall("investmentsHoldingsGet", ctx, async () => { throw failErr; }, { record }); } catch { /* attempt 1 */ }
    await instrumentProviderCall("investmentsHoldingsGet", ctx, async () => okRes, { record }); // attempt 2
    check("retry: two immutable attempts recorded", rows.length === 2);
    check("retry: attempt 1 FAILED, attempt 2 SUCCEEDED (not overwritten)", rows[0].attempt === 1 && rows[0].status === "FAILED" && rows[1].attempt === 2 && rows[1].status === "SUCCEEDED");
  }

  // Pagination — distinct external requests increment attempt.
  {
    const { rows, record } = collector();
    const ctx = ctxOf();
    await instrumentProviderCall("transactionsSync", ctx, async () => okRes, { record });
    await instrumentProviderCall("transactionsSync", ctx, async () => okRes, { record });
    check("pagination: one record per external request (attempts 1,2)", rows.length === 2 && rows[0].attempt === 1 && rows[1].attempt === 2);
  }

  // Rate limit
  {
    const { rows, record } = collector();
    try { await instrumentProviderCall("accountsGet", ctxOf(), async () => { throw rateErr; }, { record }); } catch { /* expected */ }
    check("rate-limit: recorded RATE_LIMITED", rows[0].status === "RATE_LIMITED" && rows[0].httpStatus === 429);
  }

  // Telemetry failure must NOT turn a successful provider call into a failure.
  {
    let thrown = false;
    const res = await instrumentProviderCall("accountsGet", ctxOf(), async () => okRes, {
      record: () => { throw new Error("telemetry down"); },
    }).catch((e) => { thrown = true; return e; });
    check("telemetry-throw on success: call still returns result, not thrown", thrown === false && res === okRes);
  }

  // recordProviderCall swallows a write-client failure.
  {
    const throwingClient: ProviderCallWriteClient = { providerCall: { create: async () => { throw new Error("db down"); } } };
    let threw = false;
    try { await recordProviderCall({ refreshExecutionId: "e", provider: "PLAID", operation: "accountsGet", status: "SUCCEEDED", attempt: 1, startedAt: new Date(0), completedAt: new Date(0), durationMs: 0 }, throwingClient); }
    catch { threw = true; }
    check("recordProviderCall swallows write failure (best-effort)", threw === false);
  }

  console.log(failures === 0 ? "\nAll provider-call guards passed." : `\n${failures} guard(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
