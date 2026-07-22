/**
 * app/api/health/route.test.ts  (OPS-1 S6)
 *
 * Standalone tsx script (house pattern). Exercises the health route handler
 * directly — no server, no live database. DATABASE_URL points at a port
 * nothing listens on, so the DB ping fails fast and deterministically:
 * the route must degrade to a bare 503 without leaking connection details.
 * Also proves the per-IP rate limit wraps the endpoint (in-memory backend —
 * NODE_ENV is "test").
 */

// Set BEFORE import: unreachable-but-valid URL → fast ECONNREFUSED on query.
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://health:health@127.0.0.1:9/health";
delete process.env.RATE_LIMIT_ENABLED;
delete process.env.RATE_LIMIT_SHADOW;

import type { NextRequest } from "next/server";
import { GET } from "./route";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function req(ip: string): NextRequest {
  return new Request("http://localhost/api/health", {
    headers: { "x-forwarded-for": ip },
  }) as unknown as NextRequest;
}

async function main(): Promise<void> {
  console.log("1. DB unreachable → bare 503 degraded, no secrets");
  const res = await GET(req("10.0.0.1"));
  check("status 503", res.status === 503, `got ${res.status}`);
  const body = await res.text();
  const json = JSON.parse(body) as Record<string, unknown>;
  check('body.status === "degraded"', json.status === "degraded");
  check('body.db === "error"', json.db === "error");
  check(
    "body keys limited to status/db/commit/time",
    Object.keys(json).sort().join(",") === "commit,db,status,time",
    Object.keys(json).join(","),
  );
  check("no connection string in body", !body.includes("postgresql://") && !body.includes("127.0.0.1"));
  check("no env var names in body", !/DATABASE_URL|NEXTAUTH|ENCRYPTION|RESEND|CRON_SECRET/.test(body));

  console.log("2. Per-IP rate limit wraps the endpoint");
  (process.env as Record<string, string | undefined>).RATE_LIMIT_ENABLED = "true";
  let last: Response | null = null;
  for (let i = 0; i < 31; i++) {
    last = await GET(req("10.0.0.2"));
  }
  check("call 31 within a minute is 429", last?.status === 429, `got ${last?.status}`);
  const other = await GET(req("10.0.0.3"));
  check("different IP unaffected (503, not 429)", other.status === 503, `got ${other.status}`);
  delete process.env.RATE_LIMIT_ENABLED;

  console.log(failures === 0 ? "\nAll health-route tests passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
