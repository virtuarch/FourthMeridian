/**
 * lib/email/templates.test.ts
 *
 * Consolidated pure guards for every transactional-email template render.
 * Standalone tsx script (house pattern):
 *
 *     npx tsx lib/email/templates.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network.
 *
 * TEST-2 consolidation: replaces the per-template micro-suites
 *   beta-invite · email-change · email-verification · password-reset
 *   · security-alert · space-invite  (table-driven below)
 * and folds in notification (registry wiring + full/minimal renders) as a
 * bespoke section — it carries assertions the simple shape can't express.
 *
 * The shared shape for the six simple templates: a rendered {subject, text}
 * must be plain text (never HTML), carry a template-specific subject, embed the
 * URL/content it was handed, include its safety/expiry/security line(s), and
 * resolve to the correct sender identity.
 */

import { betaInviteTemplate } from "@/lib/email/templates/beta-invite";
import { emailChangeTemplate } from "@/lib/email/templates/email-change";
import { emailVerificationTemplate } from "@/lib/email/templates/email-verification";
import { passwordResetTemplate } from "@/lib/email/templates/password-reset";
import { securityAlertTemplate } from "@/lib/email/templates/security-alert";
import { spaceInviteTemplate } from "@/lib/email/templates/space-invite";
import { notificationTemplate } from "@/lib/email/templates/notification";
import { getTemplate } from "@/lib/email/templates";
import { resolveSender } from "@/lib/email/senders";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const SUPPORT_FROM = "Fourth Meridian <support@fourthmeridian.com>";
const BETA_INVITE_URL = "https://app.fourthmeridian.com/register?invite=deadbeef";
const CONFIRM_URL = "https://app.fourthmeridian.com/confirm-email-change?token=deadbeef";
const VERIFY_URL = "https://app.fourthmeridian.com/verify-email?token=deadbeef";
const RESET_URL = "https://app.fourthmeridian.com/reset-password?token=deadbeef";
const SPACE_INVITE_URL = "https://app.fourthmeridian.com/dashboard/spaces";

type Rendered = { subject: string; text: string };

// ── Table for the six simple templates ───────────────────────────────────────
// Universal per-row checks: plain-text (no HTML), subject predicate, sender
// identity. `content` holds each template's bespoke body assertions.
const SIMPLE_TEMPLATES: {
  name: string;
  senderKey: Parameters<typeof resolveSender>[0];
  expectFrom: string;
  rendered: Rendered;
  subject: (s: string) => boolean;
  content: { name: string; ok: (text: string) => boolean }[];
}[] = [
  {
    name: "beta-invite",
    senderKey: betaInviteTemplate.sender,
    expectFrom: "Fourth Meridian Beta <beta@fourthmeridian.com>",
    rendered: betaInviteTemplate.render({ inviteUrl: BETA_INVITE_URL }),
    subject: (s) => /invited to fourth meridian/i.test(s),
    content: [
      { name: "contains the exact invite URL passed in", ok: (t) => t.includes(BETA_INVITE_URL) },
      { name: "communicates the 14-day expiry", ok: (t) => /14 days/i.test(t) },
      { name: "is honest that the invite is email-bound", ok: (t) => /tied to this email/i.test(t) },
      { name: "includes a did-not-request safety line", ok: (t) => /didn't request|did not request/i.test(t) },
    ],
  },
  {
    name: "email-change",
    senderKey: emailChangeTemplate.sender,
    expectFrom: SUPPORT_FROM,
    rendered: emailChangeTemplate.render({ confirmUrl: CONFIRM_URL }),
    subject: (s) => s === "Confirm your new Fourth Meridian email",
    content: [
      { name: "contains the exact confirm URL", ok: (t) => t.includes(CONFIRM_URL) },
      { name: "communicates the expiry", ok: (t) => /expires in 1 hour/i.test(t) },
      { name: "states the change isn't applied until confirmed", ok: (t) => /will not change until you confirm/i.test(t) },
    ],
  },
  {
    name: "email-verification",
    senderKey: emailVerificationTemplate.sender,
    expectFrom: SUPPORT_FROM,
    rendered: emailVerificationTemplate.render({ verifyUrl: VERIFY_URL }),
    subject: (s) => s === "Verify your Fourth Meridian email",
    content: [
      { name: "contains the exact verify URL passed in", ok: (t) => t.includes(VERIFY_URL) },
      { name: "communicates the expiry", ok: (t) => /expires in 1 hour/i.test(t) },
      { name: "includes a did-not-sign-up safety line", ok: (t) => /didn't create|did not create/i.test(t) },
    ],
  },
  {
    name: "password-reset",
    senderKey: passwordResetTemplate.sender,
    expectFrom: SUPPORT_FROM,
    rendered: passwordResetTemplate.render({ resetUrl: RESET_URL }),
    subject: (s) => s === "Reset your Fourth Meridian password",
    content: [
      { name: "contains the exact reset URL passed in", ok: (t) => t.includes(RESET_URL) },
      { name: "communicates single-use + expiry", ok: (t) => /expires in 1 hour/i.test(t) && /once/i.test(t) },
      { name: "includes a did-not-request safety line", ok: (t) => /didn't request|did not request/i.test(t) },
      {
        name: "does not leak a bare token separate from the URL",
        ok: (t) => !t.includes("token=deadbeef\n") || t.includes(RESET_URL),
      },
    ],
  },
  {
    name: "security-alert",
    senderKey: securityAlertTemplate.sender,
    expectFrom: SUPPORT_FROM,
    rendered: securityAlertTemplate.render({
      title: "Your password was changed",
      message: "Your Fourth Meridian password was changed on Jan 1, 2026, 12:00 PM.",
    }),
    subject: (s) => s === "Fourth Meridian security alert: Your password was changed",
    content: [
      { name: "contains the message", ok: (t) => t.includes("Your Fourth Meridian password was changed on") },
      { name: "includes a what-to-do-if-not-you line", ok: (t) => /don't recognize|reset your password/i.test(t) },
    ],
  },
  {
    name: "space-invite",
    senderKey: spaceInviteTemplate.sender,
    expectFrom: SUPPORT_FROM,
    rendered: spaceInviteTemplate.render({
      spaceName: "Hogan Household",
      inviterName: "Chris",
      role: "MEMBER",
      inviteUrl: SPACE_INVITE_URL,
    }),
    subject: (s) => s === "You've been invited to Hogan Household on Fourth Meridian",
    content: [
      { name: "names the inviter", ok: (t) => t.includes("Chris") },
      { name: "names the Space", ok: (t) => t.includes("Hogan Household") },
      { name: "states the role (lowercased)", ok: (t) => t.includes("member") },
      { name: "contains the exact CTA link", ok: (t) => t.includes(SPACE_INVITE_URL) },
      { name: "carries no token (identity-gated acceptance)", ok: (t) => !t.includes("token=") },
    ],
  },
];

for (const { name, senderKey, expectFrom, rendered, subject, content } of SIMPLE_TEMPLATES) {
  console.log(`${name} template`);
  check(`${name}: subject is correct`, subject(rendered.subject), rendered.subject);
  check(`${name}: body is plain text (no HTML tags)`, !/<[^>]+>/.test(rendered.text));
  for (const c of content) check(`${name}: body ${c.name}`, c.ok(rendered.text), rendered.text);
  check(
    `${name}: sends as ${expectFrom}`,
    resolveSender(senderKey).from === expectFrom,
    resolveSender(senderKey).from,
  );
}

// ── notification (bespoke: registry wiring + full/minimal renders) ────────────
console.log("notification email template");

// Registry wiring.
check("registered under the 'notification' key", getTemplate("notification") === (notificationTemplate as never));
check("sends as the product-notification purpose", notificationTemplate.sender === "product-notification");
check(
  "product-notification resolves to notifications@ (the OPS-1 S0 reserved identity)",
  resolveSender("product-notification").from.includes("notifications@fourthmeridian.com"),
);

// Full render: title + body + action link + the why-am-I-getting-this line.
{
  const { subject, text } = notificationTemplate.render({
    title: "Chase needs attention",
    body: "We couldn't sync this institution. Reconnect to resume updates.",
    actionUrl: "https://app.fourthmeridian.com/dashboard/connections",
  });
  check("subject is the notification title", subject === "Chase needs attention");
  check("text carries the body", text.includes("We couldn't sync this institution."));
  check("text carries the action link", text.includes("View in Fourth Meridian: https://app.fourthmeridian.com/dashboard/connections"));
  check("text explains the preference provenance", text.includes("Settings → Notifications"));
}

// Minimal render: title only — no dangling link line, no empty paragraphs.
{
  const { subject, text } = notificationTemplate.render({ title: "Recovery codes regenerated" });
  check("title-only render works", subject === "Recovery codes regenerated");
  check("no action-link line when no actionUrl", !text.includes("View in Fourth Meridian"));
  check("no empty paragraphs", !text.includes("\n\n\n"));
}

console.log(failures === 0 ? "\nAll email template checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
