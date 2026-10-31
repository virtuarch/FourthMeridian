/**
 * app/api/platform/growth-revenue/invitations/invite-expiry-email.test.ts
 *
 * The three beta-invite issuance routes — approve, resend and direct invite —
 * run for real against the in-memory Prisma fake. Each must e-mail the expiry it
 * just WROTE to the invite row: the email's "You have N days" and its labelled
 * UTC date are derived from the row's invitedAt / inviteExpiresAt, never from a
 * constant in the template (audit E-1: a 3-day direct invite used to say
 * "14 days").
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/platform/growth-revenue/invitations/invite-expiry-email.test.ts
 */

import "@/lib/test-support/route-env";
import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { capturedEmails } from "@/lib/email/providers/capture";
import type { EmailMessage } from "@/lib/email/types";
import { daysPhrase, formatUtcDateTimeLabelled, wholeDaysBetween } from "@/lib/email/design/datetime";

const t = makeChecker("beta-invite routes e-mail the expiry they wrote");
const fake = new FakePrisma();
type IdH = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type H = (req: Request) => Promise<Response>;

async function world(email: string, status: string) {
  fake.reset();
  freshCache();
  const hash = await bcrypt.hash("pw", 4);
  const admin = fake.seed("User", { email: "ops@example.test", username: "ops", passwordHash: hash, emailVerifiedAt: new Date(), role: "SYSTEM_ADMIN", totpEnabled: true, totpSecret: "x" });
  const req = fake.seed("BetaAccessRequest", { email, status });
  const s = await signIn(fake, admin.id as string);
  return { req, cookie: s.cookie };
}

const lastTo = (email: string): EmailMessage | undefined =>
  capturedEmails().filter((m) => m.to === email).at(-1);

function assertEmailMatchesRow(label: string, email: string, expectDays: number) {
  const row = fake.one("BetaAccessRequest", { email })!;
  const issued = new Date(row.invitedAt as Date);
  const expires = new Date(row.inviteExpiresAt as Date);
  const msg = lastTo(email);
  const days = wholeDaysBetween(issued, expires);
  const when = formatUtcDateTimeLabelled(expires);
  t.check(`${label}: row TTL is unchanged (${expectDays} d)`, days === expectDays, days);
  t.check(`${label}: an invite e-mail was sent with html + text`, !!msg && typeof msg.html === "string" && msg.text.length > 0);
  t.check(`${label}: text states "You have ${daysPhrase(expectDays)}"`, !!msg?.text.includes(`You have ${daysPhrase(expectDays)} to redeem your invitation.`), msg?.text);
  t.check(`${label}: text states the row's expiry "${when}"`, !!msg?.text.includes(`It expires on ${when}.`), msg?.text);
  t.check(`${label}: html states the same expiry`, !!msg?.html?.includes(`It expires on ${when}.`));
  t.check(`${label}: CTA carries an invite link`, !!msg && /\/register\?invite=[0-9a-f]{64}/.test(msg.text));
}

// Every console line the routes (and the harness) emit, for the log-hygiene check.
const logged: string[] = [];
for (const k of ["log", "error", "warn", "info", "debug"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => {
    logged.push(a.map((x) => (typeof x === "string" ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(" "));
    orig(...a);
  };
}

const REQUEST_LEAD = "Your Fourth Meridian beta access is approved.";
const DIRECT_LEAD = "You've been invited to join the Fourth Meridian beta.";
function assertOrigin(label: string, email: string, origin: "request" | "direct") {
  const msg = lastTo(email);
  const ok = origin === "request"
    ? msg?.subject === "Your Fourth Meridian beta access is approved" && msg.text.includes(REQUEST_LEAD) && msg.text.includes("If you didn't request access")
    : msg?.subject === "You're invited to the Fourth Meridian beta" && msg.text.includes(DIRECT_LEAD) && msg.text.includes("If you weren't expecting this invitation");
  t.check(`${label}: ${origin} copy`, !!ok, msg?.subject);
}

async function main() {
  await installFakePrisma(fake);
  const { POST: APPROVE } = (await import("@/app/api/platform/growth-revenue/requests/[id]/approve/route")) as unknown as { POST: IdH };
  const { POST: RESEND } = (await import("@/app/api/platform/growth-revenue/requests/[id]/resend/route")) as unknown as { POST: IdH };
  const { POST: DIRECT } = (await import("@/app/api/platform/growth-revenue/invitations/route")) as unknown as { POST: H };

  t.section("approve (14-day TTL)");
  {
    const email = "approve-invitee@example.test";
    const w = await world(email, "PENDING");
    const r = await invoke(APPROVE as never, request(`/api/platform/growth-revenue/requests/${w.req.id}/approve`, { method: "POST", cookie: w.cookie }), { id: w.req.id });
    t.check("approve → 200", r.status === 200, r.body);
    assertEmailMatchesRow("approve", email, 14);
    assertOrigin("approve", email, "request");
  }

  t.section("resend (14-day TTL)");
  {
    const email = "resend-invitee@example.test";
    const w = await world(email, "APPROVED");
    const r = await invoke(RESEND as never, request(`/api/platform/growth-revenue/requests/${w.req.id}/resend`, { method: "POST", cookie: w.cookie }), { id: w.req.id });
    t.check("resend → 200", r.status === 200, r.body);
    assertEmailMatchesRow("resend", email, 14);
    assertOrigin("resend of a legacy row (no events, no audit → not determinable)", email, "request");
  }

  t.section("resend picks the origin from the row's history");
  {
    // (a) A request with a recorded form submission → request copy.
    const email = "submitted@example.test";
    const w = await world(email, "APPROVED");
    fake.seed("BetaAccessRequestEvent", { email, receivedAt: new Date() });
    await invoke(RESEND as never, request(`/api/platform/growth-revenue/requests/${w.req.id}/resend`, { method: "POST", cookie: w.cookie }), { id: w.req.id });
    assertOrigin("resend after a form submission", email, "request");

    // (b) Created by a direct invite, then re-sent → direct copy.
    const d = "direct-then-resent@example.test";
    const w2 = await world("unrelated@example.test", "PENDING");
    await invoke(DIRECT as never, request("/api/platform/growth-revenue/invitations", { method: "POST", cookie: w2.cookie, body: { email: d, expiresDays: 5 } }));
    const row = fake.one("BetaAccessRequest", { email: d })!;
    const rr = await invoke(RESEND as never, request(`/api/platform/growth-revenue/requests/${row.id}/resend`, { method: "POST", cookie: w2.cookie }), { id: row.id });
    t.check("resend of the direct invite → 200", rr.status === 200, rr.body);
    assertOrigin("resend of a direct invite", d, "direct");

    // (c) A direct invite to someone who ALSO submitted the form → request copy.
    fake.seed("BetaAccessRequestEvent", { email: d, receivedAt: new Date() });
    await invoke(RESEND as never, request(`/api/platform/growth-revenue/requests/${row.id}/resend`, { method: "POST", cookie: w2.cookie }), { id: row.id });
    assertOrigin("resend of a direct invite whose address also requested", d, "request");
  }

  for (const days of [3, 7, 30]) {
    t.section(`direct invite (${days}-day TTL chosen by the operator)`);
    const email = `direct-${days}@example.test`;
    const w = await world("unrelated@example.test", "PENDING");
    const r = await invoke(DIRECT as never, request("/api/platform/growth-revenue/invitations", { method: "POST", cookie: w.cookie, body: { email, expiresDays: days } }));
    t.check("direct invite → 200", r.status === 200, r.body);
    assertEmailMatchesRow(`direct ${days}d`, email, days);
    assertOrigin(`direct ${days}d`, email, "direct");
  }

  t.section("default direct invite (no expiresDays → route default)");
  {
    const email = "direct-default@example.test";
    const w = await world("unrelated@example.test", "PENDING");
    const r = await invoke(DIRECT as never, request("/api/platform/growth-revenue/invitations", { method: "POST", cookie: w.cookie, body: { email } }));
    t.check("direct invite → 200", r.status === 200, r.body);
    assertEmailMatchesRow("direct default", email, 7);
  }

  t.section("log hygiene across all issuance calls");
  {
    const invites = capturedEmails().filter((m) => m.to !== "unrelated@example.test");
    const tokens = invites.map((m) => m.text.match(/invite=([0-9a-f]{64})/)?.[1]).filter(Boolean) as string[];
    const leaks = logged.filter((l) => tokens.some((tk) => l.includes(tk)) || invites.some((m) => l.includes(m.to)) || l.includes("/register?invite="));
    t.check("tokens were issued (the check is live)", tokens.length >= 9, tokens.length);
    t.check("no console line carries a token, an invite link or an invitee address", leaks.length === 0, leaks);
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
