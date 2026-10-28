/**
 * lib/platform/connection-diagnostics-history.test.ts
 *
 * Platform Ops sees each wallet's background history backfill as STATUS only —
 * state, proven interval, failure code, next retry, requests today — never the
 * checkpoint itself (it carries the address) or any balance.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { statusFromCursor, emptyCheckpoint, serializeCheckpoint, MAX_CONSECUTIVE_FAILURES } from "@/lib/crypto/sol-history-backfill.core";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const base = emptyCheckpoint("acct", "7irKphsVxEfU8wtDhVgCyq7nQXUo9Q13ivUevk8qBMSN", "2026-10-28T00:00:00Z");
check("a non-SOL cursor (BTC xpub discovery) is not a history status", statusFromCursor('{"v":1,"next":3}', "2026-10-28") === null && statusFromCursor(null, "2026-10-28") === null);
const importing = statusFromCursor(serializeCheckpoint({ ...base, licensedFromISO: "2024-01-01", licensedToISO: "2026-10-28",
  top: { signature: "t", slot: 2, blockTime: 1, dateISO: "2026-10-28", preLamports: "0", postLamports: "1" },
  bottom: { signature: "b", slot: 1, blockTime: 1, dateISO: "2024-01-01", preLamports: "0", postLamports: "1" },
  usage: { dayISO: "2026-10-28", requests: 412 }, signaturesProcessed: 900 }), "2026-10-28");
check("an importing wallet: state, proven interval, requests today", importing?.state === "IMPORTING" && importing.historyFromISO === "2024-01-01" && importing.requestsToday === 412 && importing.signaturesProcessed === 900, JSON.stringify(importing));
check("…yesterday's usage is not today's", statusFromCursor(serializeCheckpoint({ ...base, usage: { dayISO: "2026-10-27", requests: 9 } }), "2026-10-28")?.requestsToday === 0);
const failed = statusFromCursor(serializeCheckpoint({ ...base, failures: MAX_CONSECUTIVE_FAILURES, lastFailure: { code: "PROVIDER_THROTTLED", atISO: "2026-10-28T01:00:00.000Z" } }), "2026-10-28");
check("a FAILED wallet shows its code and the next automatic retry (+24 h)", failed?.state === "FAILED" && failed.lastFailureCode === "PROVIDER_THROTTLED" && failed.nextAutomaticRetryISO === "2026-10-29T01:00:00.000Z", JSON.stringify(failed));
check("a legacy-staging wallet is flagged", statusFromCursor(serializeCheckpoint({ ...base, mode: "STAGING", staged: [], legacy: { fromISO: "2023-01-01", toISO: "2026-10-01" } }), "2026-10-28")?.mode === "STAGING");

const src = readFileSync(path.join(process.cwd(), "lib/platform/connection-diagnostics.ts"), "utf8");
check("diagnostics expose only the STATUS (the raw cursor never leaves the module)",
  /statusFromCursor\(w\.cursor,/.test(src) && !/cursor:\s*w\.cursor/.test(src) && !/historyBackfill:[^\n]*address/.test(src));
const widget = readFileSync(path.join(process.cwd(), "components/platform/widgets/OpsConnectionDiagnosticsWidget.tsx"), "utf8");
check("the Ops widget renders the backfill group without addresses or balances", /title="History backfill"/.test(widget) && !/walletAddress|balance/i.test(widget.split('title="History backfill"')[1].split("</Group>")[0]));

if (failures > 0) { console.error(`\nconnection-diagnostics-history: ${failures} failed.`); process.exit(1); }
console.log("\nconnection-diagnostics-history: all checks passed.");
