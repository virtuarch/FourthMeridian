/**
 * lib/alerts/delivery-capture.test.ts  (OBS-008)
 *
 * The alert-delivery failure capture: its payload carries the transport, the
 * status word and the breach COUNT — never an address, a summary or a body —
 * and the capture itself never throws.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/alerts/delivery-capture.test.ts
 */

import { buildAlertDeliveryCapture, captureAlertDeliveryFailure } from "./delivery-capture";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("payload");
{
  const p = buildAlertDeliveryCapture({ status: "error", provider: "resend", error: "boom" }, 2);
  check("area tag is alert-delivery", p.tags.area === "alert-delivery");
  check("transport + status words are tags", p.tags.transport === "resend" && p.tags.delivery_status === "error");
  check("the breach count is context", p.contexts.alert_delivery.breaches === 2);
  check("level is error", p.level === "error");
  const thrown = buildAlertDeliveryCapture(new Error("smtp down"), 1);
  check("a thrown error reads as status threw / transport unknown", thrown.tags.delivery_status === "threw" && thrown.tags.transport === "unknown");
  const leaky = buildAlertDeliveryCapture({ status: "error", provider: "resend", to: "ops@example.test", summary: "user …abc123 spent $9" }, 1);
  check("no address, no summary, no dollar figure crosses into the payload", !JSON.stringify(leaky).includes("ops@example.test") && !JSON.stringify(leaky).includes("abc123") && !JSON.stringify(leaky).includes("$9"));
}

console.log("capture never throws");
{
  let threw = false;
  try { captureAlertDeliveryFailure({ status: "error", provider: "resend", error: "x" }, 1); captureAlertDeliveryFailure(new Error("y"), 1); captureAlertDeliveryFailure(null, 0); }
  catch { threw = true; }
  check("three shapes, no throw (no DSN ⇒ no-op)", !threw);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
