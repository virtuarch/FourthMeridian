/**
 * lib/api.test.ts — ARCH-004 / OPS-003: a 500 from withApiHandler is observable.
 *
 * Executes the REAL wrapper with an injected capture (the seam), and proves the
 * default seam is the monitoring authority (lib/monitoring/capture.ts) with a
 * tags-only payload.
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/api.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";
import { withApiHandler } from "@/lib/api";
import { buildApiHandlerFailureCapture, captureApiHandlerFailure } from "@/lib/monitoring/capture";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  console.log("withApiHandler (ARCH-004)");
  const req = new Request("https://app.fourthmeridian.com/api/x?amount=999", { method: "GET" }) as unknown as NextRequest;
  const captured: Array<{ context: string; error: unknown }> = [];
  const capture = (context: string, error: unknown) => { captured.push({ context, error }); };
  const boom = new Error("prisma pool exhausted");
  const origError = console.error;
  console.error = () => {}; // the wrapper still logs; keep the test output clean

  const wrapped = withApiHandler(async () => { throw boom; }, "GET /api/x", { capture });
  const res = await wrapped(req);
  console.error = origError;
  check("an unhandled throw → 500 with the generic body (unchanged contract)",
    res.status === 500 && JSON.stringify(await res.json()) === '{"error":"Internal server error"}');
  check("…and the injected capture fired exactly once with the route label and the error",
    captured.length === 1 && captured[0].context === "GET /api/x" && captured[0].error === boom, JSON.stringify(captured.length));

  captured.length = 0;
  const ok = withApiHandler(async () => Response.json({ ok: true }) as never, "GET /api/ok", { capture });
  const okRes = await ok(req);
  check("a successful handler captures nothing", okRes.status === 200 && captured.length === 0);

  const throwingCapture = withApiHandler(async () => { throw boom; }, "GET /api/y", { capture: () => { throw new Error("sentry down"); } });
  console.error = () => {};
  let res2: Response | null = null; let threw = false;
  try { res2 = await throwingCapture(req); } catch { threw = true; }
  console.error = origError;
  check("a capture that throws does not turn the 500 into an unhandled rejection", !threw && res2?.status === 500);

  console.log("\ndefault seam");
  const api = readFileSync(path.join(process.cwd(), "lib/api.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check("the default capture is lib/monitoring/capture.ts captureApiHandlerFailure",
    api.includes("deps.capture ?? captureApiHandlerFailure") && api.includes('from "@/lib/monitoring/capture"'));
  check("the capture runs inside the catch, before the 500 is built",
    api.indexOf("capture(context, err)") > api.indexOf("catch (err)") && api.indexOf("capture(context, err)") < api.indexOf('{ error: "Internal server error" }'));
  const payload = buildApiHandlerFailureCapture({ context: "GET /api/spaces" });
  check("payload is tags-only: area + static route label, level error",
    Object.keys(payload.tags).sort().join() === "area,route" && payload.tags.area === "api-handler" &&
    payload.tags.route === "GET /api/spaces" && payload.level === "error" && !("extra" in payload) && !("contexts" in payload));
  check("captureApiHandlerFailure never throws without a DSN", (() => { try { captureApiHandlerFailure("GET /api/z", boom); return true; } catch { return false; } })());

  if (failures > 0) { console.error(`\nlib/api: ${failures} check(s) failed.`); process.exit(1); }
  console.log("\nlib/api: all checks passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
