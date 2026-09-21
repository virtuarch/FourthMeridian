/**
 * lib/plaid/plaid-log-safety.test.ts — FM-AUDIT-001
 *
 * No Plaid error object, request configuration, credential header, secret or
 * access token may reach an ordinary log. Proven with PLANTED SENTINELS: every
 * test fails if a sentinel string appears anywhere in the serialised / logged /
 * inspected representation of the error.
 *
 *   A. source layer — a REAL Plaid SDK call (real axios, real AxiosError) against a
 *      local HTTP server, through the production `plaidClient` proxy: the error a
 *      catch block receives carries no sentinel under JSON.stringify, util.inspect
 *      (showHidden, full depth), String(), a deep own-property walk, or
 *      redactedErrorForLog — and Plaid's error_code / error_type / request_id /
 *      HTTP status and every classifier still work.
 *   B. render layer alone — an UNSANITISED raw AxiosError-shaped object rendered
 *      by redactedErrorForLog carries no sentinel, and keeps the useful facts.
 *   C. withPlaidRetry's warning (the site FM-AUDIT-001 named) logs no sentinel.
 *   D. free-text scrubbing — a non-HTTP Error whose message embeds the configured
 *      secret or a token shape is scrubbed; an HTTP-client `cause` is rendered safe.
 *   E. the logging surface — no console call in any Plaid-surface file passes a
 *      raw error; the scanner itself detects a planted multi-line violation
 *      (negative control) and passes the wrapped form.
 *
 * Standalone tsx script: exits 0/1. No DB, no network beyond 127.0.0.1.
 */

import http from "node:http";
import { inspect } from "node:util";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

const SECRET = "SENTINEL-PLAID-SECRET-7f3a91c2e8b4";
const CLIENT_ID = "SENTINEL-CLIENT-ID-5d2e8a";
const ACCESS_TOKEN = "access-sandbox-SENTINEL-4b1d-9e7a-token";
process.env.PLAID_SECRET = SECRET;
process.env.PLAID_CLIENT_ID = CLIENT_ID;
process.env.PLAID_ENV = "sandbox";
delete process.env.DATABASE_URL;

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  // recordApiUsage fire-and-forgets a DB write; with no DB it fails harmlessly.
  const n = (err as { constructor?: { name?: string } })?.constructor?.name ?? "";
  if (/Prisma/.test(n)) return;
  console.error("  ✗ unexpected unhandled rejection:", String(err));
  process.exit(1);
});

const SENTINELS = [SECRET, CLIENT_ID, ACCESS_TOKEN, "SENTINEL-BODY-FIELD"];

/** Every string reachable from `v` through own properties (enumerable or not), any depth. */
function reachableStrings(v: unknown, seen = new Set<unknown>(), out: string[] = []): string[] {
  if (typeof v === "string") { out.push(v); return out; }
  if (typeof v !== "object" || v === null || seen.has(v)) return out;
  seen.add(v);
  for (const key of Reflect.ownKeys(v)) {
    if (typeof key === "string") out.push(key);
    let child: unknown;
    try { child = (v as Record<string | symbol, unknown>)[key]; } catch { continue; }
    reachableStrings(child, seen, out);
  }
  return out;
}

function leaks(label: string, rendered: string): void {
  const hit = SENTINELS.find((s) => rendered.includes(s));
  check(`${label}: no sentinel`, !hit, hit ? `found "${hit}"` : undefined);
}

function assertNoLeak(label: string, err: unknown): void {
  leaks(`${label} JSON.stringify`, JSON.stringify(err) ?? "");
  leaks(`${label} util.inspect(showHidden, depth ∞)`, inspect(err, { showHidden: true, depth: Infinity }));
  leaks(`${label} String()`, String(err));
  leaks(`${label} deep own-property walk`, reachableStrings(err).join("\n"));
}

/** A raw axios-shaped Plaid error as axios would build it — credentials everywhere. */
function rawAxiosError(): Record<string, unknown> {
  const config = {
    method: "post",
    url: "https://sandbox.plaid.com/transactions/sync",
    headers: { "PLAID-SECRET": SECRET, "PLAID-CLIENT-ID": CLIENT_ID, "Content-Type": "application/json" },
    data: JSON.stringify({ access_token: ACCESS_TOKEN, cursor: "c1" }),
  };
  const request = { _header: `POST /transactions/sync HTTP/1.1\r\nPLAID-SECRET: ${SECRET}\r\n` };
  const err = new Error("Request failed with status code 400") as Error & Record<string, unknown>;
  err.isAxiosError = true;
  err.config = config;
  err.request = request;
  err.response = {
    status: 400,
    statusText: "Bad Request",
    headers: { "x-echo": SECRET },
    config,
    request,
    data: {
      error_type: "TRANSACTIONS_ERROR",
      error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
      error_message: "Underlying transaction data changed since last page was fetched.",
      request_id: "req-abc123",
      echoed: "SENTINEL-BODY-FIELD",
    },
  };
  return err;
}

async function main(): Promise<void> {
  const errors = await import("@/lib/plaid/errors");
  const {
    sanitizeProviderErrorInPlace, redactedErrorForLog, safePlaidErrorFields, scrubSecrets,
    classifyPlaidErrorForHealth, isRetryablePlaidError, getPlaidErrorCode, parsePlaidError, plaidErrorSummary,
  } = errors;

  // ── A. source layer: a real SDK call through the production proxy ─────────
  console.log("A. real Plaid SDK error through plaidClient");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.writeHead(400, { "content-type": "application/json", "x-echo-secret": String(req.headers["plaid-secret"]) });
      res.end(JSON.stringify({
        error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED",
        error_message: "the login details of this item have changed", request_id: "req-live-1",
        display_message: null, echoed_body: body, // echo the request body back, as a hostile proxy might
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const plaid = await import("plaid");
  (plaid.PlaidEnvironments as Record<string, string>).sandbox = `http://127.0.0.1:${port}`;
  const { plaidClient } = await import("@/lib/plaid/client");
  let caught: unknown = null;
  try {
    await plaidClient.transactionsSync({ access_token: ACCESS_TOKEN });
  } catch (e) { caught = e; }
  server.close();
  check("the SDK call failed as the server dictated", caught !== null);
  const c = caught as Record<string, unknown>;
  check("it is still an AxiosError (identity preserved)", c?.isAxiosError === true && caught instanceof Error);
  assertNoLeak("A", caught);
  leaks("A redactedErrorForLog", redactedErrorForLog(caught));
  check("A: error_code survives", getPlaidErrorCode(caught) === "ITEM_LOGIN_REQUIRED");
  check("A: health classifier unchanged (NEEDS_REAUTH)", classifyPlaidErrorForHealth(caught)?.status === "NEEDS_REAUTH");
  check("A: parsePlaidError unchanged", parsePlaidError(caught, "x").code === "ITEM_LOGIN_REQUIRED");
  const fa = safePlaidErrorFields(caught);
  check("A: safe fields keep status, type, code, request_id",
    fa.httpStatus === 400 && fa.errorType === "ITEM_ERROR" && fa.errorCode === "ITEM_LOGIN_REQUIRED" && fa.requestId === "req-live-1",
    JSON.stringify(fa));
  check("A: the rendered line carries the operational facts",
    /HTTP 400/.test(redactedErrorForLog(caught)) && /code=ITEM_LOGIN_REQUIRED/.test(redactedErrorForLog(caught))
    && /request_id=req-live-1/.test(redactedErrorForLog(caught)));

  // ── B. render layer alone (an error that never passed the proxy) ─────────
  console.log("B. redactedErrorForLog on a RAW axios-shaped error");
  const raw = rawAxiosError();
  const line = redactedErrorForLog(raw);
  leaks("B redactedErrorForLog(raw)", line);
  leaks("B plaidErrorSummary(raw)", plaidErrorSummary(raw));
  check("B: keeps code, type, request_id, status, retry classification",
    /code=TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION/.test(line) && /type=TRANSACTIONS_ERROR/.test(line)
    && /request_id=req-abc123/.test(line) && /HTTP 400/.test(line) && /retryable=true/.test(line), line);

  console.log("B'. sanitizeProviderErrorInPlace on the raw error");
  const before = { retry: isRetryablePlaidError(raw), health: classifyPlaidErrorForHealth(raw), code: getPlaidErrorCode(raw) };
  const same = sanitizeProviderErrorInPlace(raw);
  check("B': returns the same object", same === raw);
  assertNoLeak("B'", raw);
  check("B': classifiers identical after sanitising",
    isRetryablePlaidError(raw) === before.retry && JSON.stringify(classifyPlaidErrorForHealth(raw)) === JSON.stringify(before.health)
    && getPlaidErrorCode(raw) === before.code);
  check("B': idempotent", sanitizeProviderErrorInPlace(raw) === raw && reachableStrings(raw).every((s) => !SENTINELS.some((x) => s.includes(x))));
  const network = Object.assign(new Error("timeout of 10000ms exceeded"), {
    isAxiosError: true, code: "ECONNABORTED", config: { headers: { "PLAID-SECRET": SECRET } }, request: { _header: SECRET },
  });
  check("B': a network failure (no response) is sanitised too", (sanitizeProviderErrorInPlace(network), !inspect(network, { showHidden: true, depth: Infinity }).includes(SECRET)));
  check("B': …and stays retryable", isRetryablePlaidError(network));
  const plain = new TypeError("boom");
  check("B': a non-HTTP error is untouched", sanitizeProviderErrorInPlace(plain) === plain && plain.message === "boom");

  // ── C. the named site: withPlaidRetry ─────────────────────────────────────
  console.log("C. withPlaidRetry warning");
  const { withPlaidRetry } = await import("@/lib/plaid/retry");
  const captured: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { captured.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { showHidden: true, depth: Infinity }))).join(" ")); };
  let calls = 0;
  try {
    await withPlaidRetry(async () => { calls++; if (calls === 1) throw rawAxiosError(); return "ok"; }, "transactionsSync");
  } finally { console.warn = origWarn; }
  check("C: retried once and succeeded", calls === 2);
  // Only the retry's own line is counted: an unrelated fire-and-forget warning (the
  // usage recorder failing with no DB, from section A) can land in this window on a
  // slower runner. The leak check still reads EVERYTHING captured.
  const retryLines = captured.filter((l) => l.startsWith("[plaid][retry]"));
  check("C: exactly one retry warning was logged", retryLines.length === 1, `${retryLines.length} of ${captured.length} captured`);
  leaks("C everything captured during the retry", captured.join("\n"));
  check("C: the warning names the code", /TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION/.test(retryLines.join("\n")));

  // ── D. free-text scrubbing ────────────────────────────────────────────────
  console.log("D. scrubSecrets / non-HTTP errors");
  const built = new Error(`request to plaid failed with PLAID-SECRET: ${SECRET} and token ${ACCESS_TOKEN} body {"access_token":"${ACCESS_TOKEN}"}`);
  leaks("D redactedErrorForLog(Error with embedded credentials)", redactedErrorForLog(built));
  leaks("D scrubSecrets(header/body shapes)", scrubSecrets(`{"secret":"abc-${SECRET}","client_id":"${CLIENT_ID}"} Authorization: Bearer xyz`));
  const wrapper = Object.assign(new Error("sync incomplete"), { cause: rawAxiosError() });
  const w = redactedErrorForLog(wrapper);
  leaks("D wrapper with an HTTP-client cause", w);
  check("D: the cause is rendered, not dropped", /\[cause\].*code=TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION/.test(w), w);

  // ── E. the logging surface ────────────────────────────────────────────────
  console.log("E. Plaid logging surface");
  const { plaidSurfaceFiles, findRawErrorLogs } = await import("@/lib/plaid/log-surface");
  const files = plaidSurfaceFiles(process.cwd());
  check("E: the surface covers the files FM-AUDIT-001 named",
    ["lib/plaid/retry.ts", "lib/plaid/backgroundHistorySync.ts", "jobs/sync-banks.ts", "lib/plaid/exchangeToken.ts"].every((f) => files.includes(f)));
  check("E: …and every client importer (scripts included)", files.includes("scripts/remove-plaid-connection.ts") && files.includes("scripts/db-wipe.ts"));
  const violations = files.flatMap((f) => findRawErrorLogs(f, readFileSync(f, "utf8")));
  check("E: no Plaid-surface console call passes a raw error", violations.length === 0,
    violations.map((v) => `${v.file}:${v.line} [${v.arg}]`).join("; "));
  const planted = "try { x() } catch (syncErr) {\n  console.warn(\n    `[plaid] failed ${id}`,\n    syncErr,\n  );\n}\n// console.error(err) in a comment is not code\n";
  check("E: negative control — the scanner catches a planted multi-line raw log", findRawErrorLogs("planted.ts", planted).length === 1);
  check("E: the wrapped form passes", findRawErrorLogs("ok.ts", planted.replace("syncErr,\n  )", "redactedErrorForLog(syncErr),\n  )")).length === 0);
  const clientSrc = readFileSync("lib/plaid/client.ts", "utf8");
  check("E: the client proxy sanitises every rejected call", /\.catch\(\(err: unknown\) => \{ throw sanitizeProviderErrorInPlace\(err\); \}\)/.test(clientSrc));

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall Plaid log-safety checks passed");
  process.exit(0);
}

main().catch((e) => { console.error("  ✗ test crashed:", e instanceof Error ? e.message : String(e)); process.exit(1); });
