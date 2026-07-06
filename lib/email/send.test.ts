/**
 * lib/email/send.test.ts  (OPS-1 S1)
 *
 * Guards for the email chokepoint. Standalone tsx script (house pattern — no
 * jest/vitest; mirrors lib/perspectives.test.ts):
 *
 *     npx tsx lib/email/send.test.ts
 *
 * Exits 0 when all cases pass and 1 on failure. Runs credential-free: the
 * chokepoint selects the capture transport in test mode, so no network and no
 * RESEND_API_KEY are needed.
 *
 * Covers:
 *   1. Template render — the smoke template produces a stable subject + text.
 *   2. Capture transport — sendEmail() records the fully-rendered message.
 *   3. Test-mode refusal — even with RESEND_API_KEY set, sendEmail never sends
 *      for real in test mode; the result is "captured", not "sent".
 */

// Force test mode BEFORE the chokepoint's transport selection reads it.
// NODE_ENV is a read-only literal under Next's types, so assign via a cast.
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

import { sendEmail } from "@/lib/email/send";
import { smokeTemplate } from "@/lib/email/templates/smoke";
import { resolveSender } from "@/lib/email/senders";
import {
  lastCapturedEmail,
  clearCapturedEmails,
  capturedEmails,
} from "@/lib/email/providers/capture";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  // ── 1. Template render ──────────────────────────────────────────────────────
  console.log("1. Smoke template renders a stable subject + text");
  const rendered = smokeTemplate.render({ note: "unit" });
  check(
    "subject is the fixed pipeline-check line",
    rendered.subject === "Fourth Meridian email pipeline check",
    `got ${JSON.stringify(rendered.subject)}`,
  );
  check("body is plain text (no HTML tags)", !/<[^>]+>/.test(rendered.text));
  check(
    "body echoes the note",
    rendered.text.includes("(unit)"),
    `got ${JSON.stringify(rendered.text)}`,
  );
  check(
    "smoke template sends as the support@ identity",
    resolveSender(smokeTemplate.sender).from ===
      "Fourth Meridian <support@fourthmeridian.com>",
    `got ${JSON.stringify(resolveSender(smokeTemplate.sender).from)}`,
  );

  // ── 2. Capture transport records the message ────────────────────────────────
  console.log("2. sendEmail() captures a fully-rendered message");
  clearCapturedEmails();
  const res1 = await sendEmail("smoke", "recipient@example.com", { note: "cap" });
  check("result status is 'captured'", res1.status === "captured", `got ${res1.status}`);
  check("result provider is 'capture'", res1.provider === "capture", `got ${res1.provider}`);
  const msg = lastCapturedEmail();
  check("exactly one message captured", capturedEmails().length === 1, `got ${capturedEmails().length}`);
  check("captured 'to' is the recipient", msg?.to === "recipient@example.com", `got ${msg?.to}`);
  check(
    "captured 'from' is the resolved sender identity",
    msg?.from === "Fourth Meridian <support@fourthmeridian.com>",
    `got ${msg?.from}`,
  );
  check("captured subject matches the template", msg?.subject === rendered.subject);
  check("captured body echoes this call's note", msg?.text.includes("(cap)") === true);

  // ── 3. Test-mode refusal (never a real send) ────────────────────────────────
  console.log("3. Chokepoint refuses a real send in test mode");
  clearCapturedEmails();
  const prevKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_dummy_should_not_be_used"; // present, yet still captured
  const res2 = await sendEmail("smoke", "nobody@example.com");
  check(
    "result is 'captured' even with a key present in test mode",
    res2.status === "captured",
    `got ${res2.status}`,
  );
  check("no real provider id was returned", res2.id === undefined, `got ${res2.id}`);
  // Restore env for hygiene.
  if (prevKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = prevKey;

  console.log(
    failures === 0 ? "\nAll email chokepoint checks passed." : `\n${failures} failure(s).`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
