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
 *   4. html + text: a design-system template's message carries both parts and
 *      both reach the Resend payload; a text-only template sends no html key.
 *   5. Non-throwing render: a template that refuses its data is an error result.
 *   6. Log hygiene: no token, link or recipient address in any console call or
 *      in the provider error string callers log.
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
import { createResendAdapter, type ResendPayload, type ResendLikeClient } from "@/lib/email/providers/resend";
import type { EmailMessage } from "@/lib/email/types";

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

  // ── 4. html + text reach the provider ───────────────────────────────────────
  console.log("4. html + text reach the provider payload");
  const TOKEN = "f".repeat(64);
  const INVITE_URL = `https://app.fourthmeridian.com/register?invite=${TOKEN}`;
  const RECIPIENT = "invitee.private@example.com";
  const inviteData = {
    inviteUrl: INVITE_URL,
    issuedAt: new Date("2026-10-31T15:04:00Z"),
    expiresAt: new Date("2026-11-07T15:04:00Z"),
  };
  clearCapturedEmails();
  const res3 = await sendEmail("beta-invite", RECIPIENT, inviteData);
  const inv = lastCapturedEmail();
  check("beta-invite is captured", res3.status === "captured", res3.status);
  check("captured message carries html", typeof inv?.html === "string" && inv.html.startsWith("<!DOCTYPE html>"));
  check("captured message still carries text", typeof inv?.text === "string" && inv.text.includes(INVITE_URL));
  check("captured smoke message (text-only) has no html key", capturedEmails().length === 1 && !("html" in (msg ?? {})));

  const payloads: ResendPayload[] = [];
  const okClient: ResendLikeClient = {
    emails: { send: async (p) => { payloads.push(p); return { data: { id: "re_test_1" }, error: null }; } },
  };
  const adapter = createResendAdapter(() => okClient);
  const r4 = await adapter.send(inv as EmailMessage);
  check("adapter reports sent with the provider id", r4.status === "sent" && r4.id === "re_test_1", JSON.stringify(r4));
  check("payload carries html AND text", payloads[0]?.html === inv?.html && payloads[0]?.text === inv?.text);
  check("payload carries subject/from/to unchanged", payloads[0]?.subject === inv?.subject && payloads[0]?.from === inv?.from && payloads[0]?.to === RECIPIENT);
  await adapter.send({ to: RECIPIENT, from: "a <a@example.com>", subject: "s", text: "t" });
  check("text-only message → payload has no html key", !("html" in payloads[1]!) && payloads[1]?.text === "t");

  // ── 5. render failure is a result, not a throw ──────────────────────────────
  console.log("5. a refused render is an error result");
  clearCapturedEmails();
  let threw = false;
  let res5: Awaited<ReturnType<typeof sendEmail>> | undefined;
  try {
    res5 = await sendEmail("beta-invite", RECIPIENT, { ...inviteData, inviteUrl: `javascript:alert('${TOKEN}')` });
  } catch { threw = true; }
  check("does not throw", !threw);
  check("status error, nothing captured", res5?.status === "error" && capturedEmails().length === 0, JSON.stringify(res5));
  check("error message does not echo the data", !!res5?.error && !res5.error.includes(TOKEN) && !res5.error.includes("javascript"), res5?.error);

  // ── 6. no token, link or address in logs ────────────────────────────────────
  console.log("6. log hygiene");
  const logged: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  const spy = (...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.log = spy; console.error = spy; console.warn = spy; console.info = spy; console.debug = spy;
  let errRes: Awaited<ReturnType<typeof adapter.send>>;
  let throwRes: Awaited<ReturnType<typeof adapter.send>>;
  try {
    clearCapturedEmails();
    await sendEmail("beta-invite", RECIPIENT, inviteData);
    // A provider validation error that echoes the recipient and the body link.
    const echoing = createResendAdapter(() => ({
      emails: { send: async () => ({ data: null, error: { message: `Invalid \`to\` field ${RECIPIENT}; body link ${INVITE_URL} token ${TOKEN}` } }) },
    }));
    errRes = await echoing.send(lastCapturedEmail()!);
    const throwing = createResendAdapter(() => ({
      emails: { send: async () => { throw new Error(`socket closed sending to <${RECIPIENT}> (${INVITE_URL})`); } },
    }));
    throwRes = await throwing.send(lastCapturedEmail()!);
    // What the routes do with a failed result (approve/resend/invitations).
    if (errRes.status === "error") console.error("[beta-approve] invite email failed to send:", errRes.error);
    if (throwRes.status === "error") console.error("[beta-resend] invite email failed to send:", throwRes.error);
  } finally {
    Object.assign(console, orig);
  }
  const leaks = logged.filter((l) => l.includes(TOKEN) || l.includes(INVITE_URL) || l.includes(RECIPIENT) || l.includes("invitee.private"));
  check("console calls were made (the spy is live)", logged.length >= 2, String(logged.length));
  check("no console call carries the token, the link or the address", leaks.length === 0, leaks.join(" | "));
  check("returned provider error is redacted", errRes!.status === "error" && errRes!.error!.includes("[email]") && errRes!.error!.includes("[url]") && !errRes!.error!.includes(TOKEN), errRes!.error);
  check("thrown provider error is redacted", throwRes!.status === "error" && !throwRes!.error!.includes(RECIPIENT) && !throwRes!.error!.includes(TOKEN), throwRes!.error);

  console.log(
    failures === 0 ? "\nAll email chokepoint checks passed." : `\n${failures} failure(s).`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
