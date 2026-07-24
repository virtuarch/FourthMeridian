/**
 * lib/platform/refresh/execution-query.test.ts  (OPS-2B)
 *
 * Security + contract guards for the Execution Query Seam. Standalone tsx (house
 * pattern). Injected in-memory readers — no database.
 *
 * What this pins:
 *   • SECURITY — support scope fails CLOSED (never widens to platform-wide), and
 *     a scoped caller cannot reach an execution outside its connections even by
 *     direct id.
 *   • REDACTION — free-text error bodies reach `operator` only; the structured
 *     provider vocabulary reaches both.
 *   • DTO STABILITY — every DTO has exactly its declared keys, so a ledger column
 *     added later cannot leak through a row spread.
 *   • NO AGGREGATION — the seam computes no totals, no counts, no health.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  resolveScope,
  COVERAGE_ROW_KEYS,
  ENDPOINT_ROW_KEYS,
  EXECUTION_ROW_KEYS,
  PROVIDER_CALL_ROW_KEYS,
  SEAM_AUDIENCES,
  MAX_PAGE_SIZE,
} from "@/lib/platform/refresh/execution-query-core";
import {
  getRefreshExecutionDetail,
  queryRefreshExecutions,
  type ExecutionQueryReaders,
} from "@/lib/platform/refresh/execution-query";
import type {
  CoverageFact,
  EndpointFact,
  ExecutionFact,
  ProviderCallFact,
} from "@/lib/platform/refresh/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected:", err);
  process.exit(1);
});

const D = (iso: string) => new Date(iso);

function execution(over: Partial<ExecutionFact> = {}): ExecutionFact {
  return {
    id: "exec1",
    runId: "run1",
    plaidItemId: "item1",
    trigger: "MANUAL",
    profile: "FULL_REFRESH",
    startedAt: D("2026-07-10T06:00:00.000Z"),
    completedAt: D("2026-07-10T06:00:10.000Z"),
    durationMs: 10_000,
    overallStatus: "PARTIAL",
    parentJobRunId: null,
    errorSummary: "ITEM_LOGIN_REQUIRED at /accounts/get for item ins_3",
    ...over,
  };
}
function endpoint(over: Partial<EndpointFact> = {}): EndpointFact {
  return {
    refreshExecutionId: "exec1",
    endpoint: "BALANCES",
    stageKind: "PROVIDER",
    status: "FAILED",
    skipReason: null,
    startedAt: D("2026-07-10T06:00:01.000Z"),
    completedAt: D("2026-07-10T06:00:04.000Z"),
    durationMs: 3_000,
    recordsRead: null,
    recordsWritten: null,
    recordsChanged: null,
    freshnessAdvanced: null,
    errorSummary: "internal stack detail for operators",
    ...over,
  };
}
function call(over: Partial<ProviderCallFact> = {}): ProviderCallFact {
  return {
    refreshExecutionId: "exec1",
    endpoint: "BALANCES",
    provider: "PLAID",
    operation: "accountsGet",
    status: "FAILED",
    attempt: 1,
    startedAt: D("2026-07-10T06:00:01.000Z"),
    completedAt: D("2026-07-10T06:00:03.000Z"),
    durationMs: 2_000,
    providerRequestId: "req-abc",
    httpStatus: 400,
    errorCode: "ITEM_LOGIN_REQUIRED",
    errorCategory: "ITEM_ERROR",
    ...over,
  };
}
function coverage(over: Partial<CoverageFact> = {}): CoverageFact {
  return {
    refreshExecutionId: "exec1",
    endpoint: "BALANCES",
    financialAccountId: "acct1",
    status: "SKIPPED",
    reason: "ACCOUNT_DISCONNECTED",
    freshnessAdvanced: false,
    createdAt: D("2026-07-10T06:00:04.000Z"),
    ...over,
  };
}

function fakeReaders(over: Partial<ExecutionQueryReaders> = {}): ExecutionQueryReaders {
  return {
    executions: async () => [execution()],
    execution: async () => execution(),
    endpoints: async () => [endpoint()],
    providerCalls: async () => [call()],
    coverage: async () => [coverage()],
    ...over,
  };
}

async function main() {
  // ── scope: fails closed ────────────────────────────────────────────────────────
  console.log("security · scope fails closed");
  {
    check("support with NO scope resolves to nothing", resolveScope("support", undefined) === null);
    check("support with an EMPTY id list resolves to nothing", resolveScope("support", { plaidItemIds: [] }) === null);
    check("support with ids resolves", resolveScope("support", { plaidItemIds: ["a"] })?.plaidItemIds?.length === 1);
    check("operator may read platform-wide", resolveScope("operator", undefined)?.plaidItemIds === undefined);
    check("operator with an EMPTY list still reads nothing (explicit ≠ absent)", resolveScope("operator", { plaidItemIds: [] }) === null);

    let readerHit = false;
    const page = await queryRefreshExecutions(
      { audience: "support" },
      { readers: fakeReaders({ executions: async () => { readerHit = true; return [execution()]; } }) },
    );
    check("an unscoped SUPPORT query returns an empty page", page.rows.length === 0);
    check("...and flags the denial rather than pretending there is no data", page.scopeDenied === true);
    check("...and never reaches the database at all", readerHit === false);

    const wide = await queryRefreshExecutions({ audience: "operator" }, { readers: fakeReaders() });
    check("an unscoped OPERATOR query is permitted", wide.rows.length === 1 && wide.scopeDenied === false);
  }

  // ── scope: direct-id escape is blocked ─────────────────────────────────────────
  console.log("security · no direct-id escape");
  {
    const detail = await getRefreshExecutionDetail(
      { audience: "support", scope: { plaidItemIds: ["OTHER-ITEM"] }, executionId: "exec1" },
      { readers: fakeReaders() },
    );
    check("a scoped caller cannot read an execution outside its scope by id", detail === null);

    const allowed = await getRefreshExecutionDetail(
      { audience: "support", scope: { plaidItemIds: ["item1"] }, executionId: "exec1" },
      { readers: fakeReaders() },
    );
    check("a scoped caller CAN read an execution inside its scope", allowed?.execution.id === "exec1");

    const unscoped = await getRefreshExecutionDetail(
      { audience: "support", executionId: "exec1" },
      { readers: fakeReaders() },
    );
    check("an unscoped support detail read returns null", unscoped === null);

    const missing = await getRefreshExecutionDetail(
      { audience: "operator", executionId: "nope" },
      { readers: fakeReaders({ execution: async () => null }) },
    );
    check("a missing execution returns null (no existence disclosure difference)", missing === null);
  }

  // ── redaction ──────────────────────────────────────────────────────────────────
  console.log("security · redaction by audience");
  {
    const operator = await getRefreshExecutionDetail(
      { audience: "operator", executionId: "exec1" },
      { readers: fakeReaders() },
    );
    const support = await getRefreshExecutionDetail(
      { audience: "support", scope: { plaidItemIds: ["item1"] }, executionId: "exec1" },
      { readers: fakeReaders() },
    );

    check("operator sees the free-text execution errorSummary", operator!.execution.errorSummary != null);
    check("SUPPORT does NOT see the free-text execution errorSummary", support!.execution.errorSummary === null);
    check("support still learns THAT it errored", support!.execution.hasError === true);

    check("operator sees the free-text stage errorSummary", operator!.endpoints[0].errorSummary != null);
    check("SUPPORT does NOT see the free-text stage errorSummary", support!.endpoints[0].errorSummary === null);
    check("support still learns THAT the stage errored", support!.endpoints[0].hasError === true);

    // The structured provider vocabulary IS safe to relay — it is Plaid's own.
    check("support DOES receive the structured provider errorCode", support!.providerCalls[0].errorCode === "ITEM_LOGIN_REQUIRED");
    check("support DOES receive the provider errorCategory", support!.providerCalls[0].errorCategory === "ITEM_ERROR");
    check("support DOES receive providerRequestId (the documented support handle)", support!.providerCalls[0].providerRequestId === "req-abc");

    const supportJson = JSON.stringify(support);
    check("no free-text internal detail reaches support anywhere in the payload", !supportJson.includes("internal stack detail") && !supportJson.includes("at /accounts/get"));

    const pageSupport = await queryRefreshExecutions(
      { audience: "support", scope: { plaidItemIds: ["item1"] } },
      { readers: fakeReaders() },
    );
    check("list rows are redacted for support too", pageSupport.rows[0].errorSummary === null && pageSupport.rows[0].hasError === true);
  }

  // ── DTO stability ──────────────────────────────────────────────────────────────
  console.log("contract · DTO stability");
  {
    const detail = await getRefreshExecutionDetail(
      { audience: "operator", executionId: "exec1" },
      { readers: fakeReaders() },
    );
    const keysOf = (o: object) => Object.keys(o).sort().join(",");

    check("execution DTO has exactly its declared keys", keysOf(detail!.execution) === [...EXECUTION_ROW_KEYS].sort().join(","));
    check("endpoint DTO has exactly its declared keys", keysOf(detail!.endpoints[0]) === [...ENDPOINT_ROW_KEYS].sort().join(","));
    check("provider-call DTO has exactly its declared keys", keysOf(detail!.providerCalls[0]) === [...PROVIDER_CALL_ROW_KEYS].sort().join(","));
    check("coverage DTO has exactly its declared keys", keysOf(detail!.coverage[0]) === [...COVERAGE_ROW_KEYS].sort().join(","));

    // A column added to the ledger later must NOT reach a consumer.
    const withExtra = await getRefreshExecutionDetail(
      { audience: "operator", executionId: "exec1" },
      {
        readers: fakeReaders({
          execution: async () =>
            ({ ...execution(), encryptedToken: "SECRET", futureColumn: "leak" }) as unknown as ExecutionFact,
        }),
      },
    );
    check("an unexpected ledger column is NOT projected into the DTO", keysOf(withExtra!.execution) === [...EXECUTION_ROW_KEYS].sort().join(","));
    check("...and its value never appears in the payload", !JSON.stringify(withExtra).includes("SECRET"));

    check("dates are serialized as ISO strings, never Date objects", typeof detail!.execution.startedAt === "string");
    check("there is deliberately NO customer audience", !(SEAM_AUDIENCES as readonly string[]).includes("customer"));
  }

  // ── paging ─────────────────────────────────────────────────────────────────────
  console.log("contract · keyset paging");
  {
    check("limit defaults when unset", clampLimit(undefined) === 50);
    check("limit is clamped to the maximum", clampLimit(10_000) === MAX_PAGE_SIZE);
    check("limit floors at 1", clampLimit(0) === 1);

    const cursor = encodeCursor({ startedAt: "2026-07-10T06:00:00.000Z", id: "exec1" });
    const round = decodeCursor(cursor);
    check("cursor round-trips", round?.id === "exec1" && round?.startedAt === "2026-07-10T06:00:00.000Z");
    check("a malformed cursor degrades to null, never throws", decodeCursor("!!!not-base64!!!") === null);
    check("an empty cursor is null", decodeCursor(undefined) === null);

    const many = Array.from({ length: 5 }, (_, i) =>
      execution({ id: `e${i}`, startedAt: D(`2026-07-1${i}T06:00:00.000Z`) }),
    );
    let requestedTake = 0;
    const page = await queryRefreshExecutions(
      { audience: "operator", limit: 2 },
      { readers: fakeReaders({ executions: async (p) => { requestedTake = p.take; return many.slice(0, p.take); } }) },
    );
    check("reads limit+1 to detect a further page (never a COUNT)", requestedTake === 3);
    check("returns exactly the requested page size", page.rows.length === 2);
    check("emits a continuation cursor when more rows exist", page.nextCursor != null);

    const lastPage = await queryRefreshExecutions(
      { audience: "operator", limit: 10 },
      { readers: fakeReaders({ executions: async () => many }) },
    );
    check("emits NO cursor on the final page", lastPage.nextCursor === null);
  }

  // ── filters are passed through, never re-implemented ───────────────────────────
  console.log("contract · filters compose");
  {
    let seen: { overallStatus?: readonly string[]; trigger?: readonly string[] } = {};
    await queryRefreshExecutions(
      { audience: "operator", filter: { overallStatus: ["FAILED"], trigger: ["CRON"] } },
      { readers: fakeReaders({ executions: async (p) => { seen = p; return []; } }) },
    );
    check("status filter reaches the reader", seen.overallStatus?.[0] === "FAILED");
    check("trigger filter reaches the reader", seen.trigger?.[0] === "CRON");
  }

  // ── doctrine: the seam aggregates nothing ──────────────────────────────────────
  console.log("doctrine · seam performs no aggregation");
  {
    const strip = (p: string) =>
      readFileSync(path.join(process.cwd(), p), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    const seam = strip("lib/platform/refresh/execution-query.ts");
    const core = strip("lib/platform/refresh/execution-query-core.ts");

    check("no Prisma aggregate / groupBy / count in the seam", !/\.aggregate\(|\.groupBy\(|\.count\(/.test(seam));
    check("no reduce/sum folding in the seam", !/\.reduce\(/.test(seam));
    check("the seam imports NO projection module", !/refresh\/projections/.test(seam));
    check("the seam derives no health state", !/health|classify|tier/i.test(seam.replace(/import[\s\S]*?;/g, "")));
    check("the seam performs no writes", !/\.create\(|\.update\(|\.upsert\(|deleteMany/.test(seam));
    check("the pure core touches no db", !/@\/lib\/db/.test(core));
    check("DTOs are built field-by-field, never by spreading a ledger row", !/\.\.\.row\b/.test(core));
    check("no caching is introduced", !/unstable_cache|revalidate|lruCache/i.test(seam));
  }

  if (failures > 0) {
    console.error(`\nexecution-query.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nexecution-query.test: all passed.");
}

void main();
