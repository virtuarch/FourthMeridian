/**
 * lib/email/migration.test.ts  (PR D — every transactional email on the design system)
 *
 * Behavioural guards for the migration:
 *   1. every template renders HTML + text from ONE block list (same CTA, same copy);
 *   2. every interpolated field is escaped (institution / Space / note / address);
 *   3. CTA URLs come from the trusted app base and are http(s)-validated;
 *   4. token-lifetime copy derives from the real TTL constants;
 *   5. connection state → copy + CTA; unknown → conservative, never "disconnected";
 *      the producer derives the state from the item status, nothing else changes;
 *   6. no token reaches a log line or an error result;
 *   7. the security variant carries no promotional block.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/email/migration.test.ts
 *
 * No DB, no network: sendEmail runs on the capture transport (NODE_ENV=test).
 */

(process.env as Record<string, string | undefined>).NODE_ENV = "test";

import { readFileSync } from "node:fs";
import { previewCases, PREVIEW_APP_BASE } from "@/lib/email/preview";
import { getTemplate } from "@/lib/email/templates";
import { renderPasswordReset } from "@/lib/email/templates/password-reset";
import { renderEmailVerification } from "@/lib/email/templates/email-verification";
import { renderEmailChange } from "@/lib/email/templates/email-change";
import { renderSecurityAlert, DEFAULT_SECURITY_GUIDANCE } from "@/lib/email/templates/security-alert";
import { renderNotificationEmail } from "@/lib/email/templates/notification";
import { renderSpaceInvite } from "@/lib/email/templates/space-invite";
import { renderBetaRequest } from "@/lib/email/templates/beta-request";
import { renderEmail } from "@/lib/email/design/render";
import { durationPhrase } from "@/lib/email/design/datetime";
import { PASSWORD_RESET_TTL_MS, EMAIL_VERIFICATION_TTL_MS, EMAIL_CHANGE_TTL_MS } from "@/lib/email/token-ttl";
import { buildAppLink, APP_PATHS } from "@/lib/email/app-link";
import * as alerts from "@/lib/email/security-alerts";
import { sendEmail } from "@/lib/email/send";
import { clearCapturedEmails, lastCapturedEmail } from "@/lib/email/providers/capture";
import { getNotificationDefinition } from "@/lib/notifications/registry";
import { buildNotificationEmailData } from "@/lib/notifications/channels/email-data";
import { emailNotificationAdapter } from "@/lib/notifications/channels/email";
import {
  connectionAttentionCopy,
  connectionStateFromItemStatus,
  parseConnectionState,
} from "@/lib/notifications/connection-attention";
import { notifyItemSyncFailed, type PlaidItemReadClient } from "@/lib/plaid/sync-notifications";
import type { EmailBrandConfig } from "@/lib/email/design/config";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

const BRAND: EmailBrandConfig = { siteOrigin: "https://fourthmeridian.com", supportEmail: "support@fourthmeridian.com" };
const NASTY = `<script>alert("x")</script> & 'Co'`;
const SECURITY_VARIANT_SLUGS = ["password-reset", "email-verification", "email-change--", "security-alert--"];

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}

async function main(): Promise<void> {
  // ── 1. one block list → HTML + text ─────────────────────────────────────────
  console.log("1. every template renders HTML + text from one block list");
  for (const c of previewCases()) {
    const r = getTemplate(c.template).render(c.data as never);
    const html = r.html ?? "";
    check(`${c.slug}: has both parts`, html.startsWith("<!DOCTYPE html>") && r.text.length > 0);
    check(`${c.slug}: text part is plain (no tags)`, !/<[a-z][^>]*>/i.test(r.text));
    // Every in-body CTA href (not footer legal/settings links) is also printed in the text part.
    const ctaHrefs = [...html.matchAll(/class="fm-cta-cell"[^>]*><a href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    check(`${c.slug}: each CTA URL appears in the text part`, ctaHrefs.every((u) => r.text.includes(u)), ctaHrefs);
    check(`${c.slug}: wordmark + legal footer in both parts`,
      html.includes("Privacy Policy") && r.text.includes("Privacy Policy:") && r.text.startsWith("Fourth Meridian\n"));
  }

  // ── 2. escaping ────────────────────────────────────────────────────────────
  console.log("2. every interpolated field is escaped");
  {
    const def = getNotificationDefinition("SYNC_FAILED")!;
    for (const state of ["sync-failed", "reauth-required", "disconnected"]) {
      const r = def.render({ plaidItemId: "i", institutionName: NASTY, connectionState: state });
      const data = buildNotificationEmailData({ ...r, category: def.category }, "https://app.fourthmeridian.com");
      const e = renderNotificationEmail(data, { brand: BRAND });
      check(`institution name escaped (${state})`, !e.html.includes("<script>") && e.html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Co&#39;"));
    }
    const s = renderSpaceInvite({ spaceName: NASTY, inviterName: NASTY, role: "MEMBER", inviteUrl: "https://app.fourthmeridian.com/dashboard/spaces" }, { brand: BRAND });
    check("space + inviter names escaped", !s.html.includes("<script>") && s.html.includes("&lt;script&gt;"));
    const b = renderBetaRequest({ applicantEmail: `a"<b>@example.invalid`, note: `${NASTY}\nForged: line`, queueUrl: "https://app.fourthmeridian.com/q" }, { brand: BRAND });
    check("applicant email + note escaped", !b.html.includes("<script>") && !b.html.includes(`a"<b>`) && b.html.includes("a&quot;&lt;b&gt;"));
    check("note cannot forge a text line", !b.text.includes("\nForged: line"));
    const a = renderSecurityAlert(alerts.emailChangeRequestedAlert(`x"><img src=x>@example.invalid`, new Date("2026-10-31T15:04:00Z")), { brand: BRAND });
    check("new address in the old-address alert escaped", !a.html.includes("<img src=x>") && a.html.includes("&quot;&gt;&lt;img"));
    const t = renderNotificationEmail({ title: NASTY, body: NASTY }, { brand: BRAND });
    check("notification title (also <title>) escaped", !t.html.includes("<script>"));
  }

  // ── 3. CTA URLs from the trusted base, http(s)-validated ───────────────────
  console.log("3. CTA URLs come from NEXT_PUBLIC_APP_URL and are http(s)-validated");
  {
    const BASE = "https://preview-app.example.invalid/";
    check("export CTA → account security page on the given base",
      alerts.dataExportedAlert(new Date(), BASE).action?.url === "https://preview-app.example.invalid/dashboard/settings/security");
    check("owner anomaly CTA → /forgot-password on the given base (no token)",
      alerts.ownerSignInAnomalyAlert(BASE).action?.url === "https://preview-app.example.invalid/forgot-password");
    check("a javascript: base is refused", throws(() => alerts.dataExportedAlert(new Date(), "javascript:alert(1)//")));
    check("a relative base is refused", throws(() => buildAppLink("/app", APP_PATHS.connections)));
    check("a credentialed base is refused", throws(() => buildAppLink("https://u:p@app.example.invalid", APP_PATHS.connections)));
    check("a template refuses a non-http CTA", throws(() => renderPasswordReset({ resetUrl: "javascript:alert(1)" })));
    const nd = buildNotificationEmailData({ title: "t", href: "/dashboard/connections", actionLabel: "Reconnect", category: "FINANCIAL" }, BASE);
    check("notification CTA + settings link use the base",
      nd.actionUrl === "https://preview-app.example.invalid/dashboard/connections" &&
      nd.preferencesUrl === "https://preview-app.example.invalid/dashboard/settings/notifications" && nd.actionLabel === "Reconnect");
    check("no base → no CTA, no settings link (never a relative link)", (() => {
      const d = buildNotificationEmailData({ title: "t", href: "/x", actionLabel: "Go", category: "FINANCIAL" }, undefined);
      return !d.actionUrl && !d.preferencesUrl && !d.actionLabel;
    })());
    // The channel reads NEXT_PUBLIC_APP_URL.
    const prev = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://channel-base.example.invalid";
    clearCapturedEmails();
    const res = await emailNotificationAdapter.deliver({
      userId: "u", email: "owner@example.invalid", type: "SYNC_FAILED", category: "FINANCIAL", priority: "HIGH",
      title: "We couldn't sync Chase", body: "b", href: "/dashboard/connections", actionLabel: "Review connection",
    });
    const msg = lastCapturedEmail();
    process.env.NEXT_PUBLIC_APP_URL = prev;
    check("channel → captured with html", res.status === "captured" && typeof msg?.html === "string");
    check("channel CTA built from NEXT_PUBLIC_APP_URL with the registry label",
      !!msg?.html && hrefs(msg.html).includes("https://channel-base.example.invalid/dashboard/connections") && msg.text.includes("Review connection:\nhttps://channel-base.example.invalid/dashboard/connections"));
    check("channel footer links notification settings on the same base",
      !!msg && msg.text.includes("Manage notification settings: https://channel-base.example.invalid/dashboard/settings/notifications"));
    // Every href in every preview is absolute http(s) (the design system validated it).
    const bad = previewCases().flatMap((c) => hrefs(getTemplate(c.template).render(c.data as never).html ?? "")
      .filter((h) => !/^(https?:\/\/|mailto:)/.test(h)).map((h) => `${c.slug}: ${h}`));
    check("every preview href is absolute http(s) or mailto", bad.length === 0, bad);
    const appHrefs = previewCases().flatMap((c) => hrefs(getTemplate(c.template).render(c.data as never).html ?? ""))
      .filter((h) => h.startsWith("https://app."));
    check("every app link in the previews uses the preview app base", appHrefs.every((h) => h.startsWith(PREVIEW_APP_BASE)));
  }

  // ── 4. TTL copy derives from the real constants ────────────────────────────
  console.log("4. token lifetime copy derives from the shared constants");
  {
    check("real lifetimes are 1 hour (pins the audit; a mutation fails here)",
      PASSWORD_RESET_TTL_MS === 3_600_000 && EMAIL_VERIFICATION_TTL_MS === 3_600_000 && EMAIL_CHANGE_TTL_MS === 3_600_000);
    const URL_ = "https://app.fourthmeridian.com/x?token=t";
    for (const [name, render, constant] of [
      ["password-reset", (ms?: number) => renderPasswordReset({ resetUrl: URL_ }, { brand: BRAND, ttlMs: ms }), PASSWORD_RESET_TTL_MS],
      ["email-verification", (ms?: number) => renderEmailVerification({ verifyUrl: URL_ }, { brand: BRAND, ttlMs: ms }), EMAIL_VERIFICATION_TTL_MS],
      ["email-change", (ms?: number) => renderEmailChange({ confirmUrl: URL_ }, { brand: BRAND, ttlMs: ms }), EMAIL_CHANGE_TTL_MS],
    ] as const) {
      const def = render();
      check(`${name}: default copy states durationPhrase(the constant)`, def.text.includes(`expires in ${durationPhrase(constant)}`) && def.html.includes(`expires in ${durationPhrase(constant)}`));
      check(`${name}: default copy says "1 hour"`, def.text.includes("expires in 1 hour"));
      const two = render(2 * 3_600_000);
      check(`${name}: a different TTL changes the text (2 hours)`, two.text.includes("expires in 2 hours") && !two.text.includes("1 hour"));
      check(`${name}: 90 minutes → "90 minutes"`, render(90 * 60_000).text.includes("expires in 90 minutes"));
    }
    check("durationPhrase refuses a zero TTL", throws(() => durationPhrase(0)));
    check("durationPhrase: 1 day", durationPhrase(86_400_000) === "1 day");
    // The routes that WRITE the expiry read the same constants (no second literal).
    for (const [file, constant] of [
      ["app/api/auth/forgot-password/route.ts", "PASSWORD_RESET_TTL_MS"],
      ["app/api/auth/register/route.ts", "EMAIL_VERIFICATION_TTL_MS"],
      ["lib/email/verification.ts", "EMAIL_VERIFICATION_TTL_MS"],
      ["app/api/user/email/request/route.ts", "EMAIL_CHANGE_TTL_MS"],
    ] as const) {
      const src = readFileSync(file, "utf8");
      check(`${file} imports ${constant} from token-ttl`, src.includes(`import { ${constant} } from "@/lib/email/token-ttl"`));
      check(`${file} has no separate 1-hour TTL literal`, !/TTL_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/.test(src));
    }
  }

  // ── 5. connection state ────────────────────────────────────────────────────
  console.log("5. connection state → copy + CTA (conservative fallback)");
  {
    check("NEEDS_REAUTH → reauth-required", connectionStateFromItemStatus("NEEDS_REAUTH") === "reauth-required");
    check("REVOKED → disconnected", connectionStateFromItemStatus("REVOKED") === "disconnected");
    check("ERROR → sync-failed (never disconnected)", connectionStateFromItemStatus("ERROR") === "sync-failed");
    check("ACTIVE / null / junk → sync-failed", ["ACTIVE", null, undefined, "WHATEVER"].every((s) => connectionStateFromItemStatus(s) === "sync-failed"));
    check("parse: unknown values → sync-failed", [undefined, null, 7, "", "DISCONNECTED", "disconnected "].every((v) => parseConnectionState(v) === "sync-failed"));

    const reauth = connectionAttentionCopy("reauth-required", "Chase");
    check("reauth copy + CTA", reauth.title === "Chase needs you to sign in again" && reauth.actionLabel === "Reconnect Chase");
    const disc = connectionAttentionCopy("disconnected", "Chase");
    check("disconnected copy + CTA", disc.title === "Chase is disconnected" && disc.actionLabel === "Reconnect");
    const fail = connectionAttentionCopy("sync-failed", "Chase");
    check("sync-failed copy + CTA", fail.title === "We couldn't sync Chase" && fail.actionLabel === "Review connection");
    for (const junk of [undefined, "stale", "DISCONNECTED", 42]) {
      const c = connectionAttentionCopy(junk, "Chase");
      check(`unknown state ${JSON.stringify(junk)} → the sync-failed copy, never "disconnected"`,
        c.title === fail.title && c.actionLabel === fail.actionLabel && !/disconnect/i.test(c.title + c.body));
    }
    const all = ["sync-failed", "reauth-required", "disconnected"].map((s) => connectionAttentionCopy(s, "Chase"));
    check("no state claims a reconnection succeeded", all.every((c) => !/reconnected|successfully|is back|restored/i.test(c.title + c.body)));
    check("sync-failed copy never promises an automatic retry (ERROR items are not re-synced by the cron)",
      !/retry|automatically/i.test(fail.title + fail.body));
    check("no copy carries numbers (no balances / account numbers)", all.every((c) => !/\d/.test(c.title + c.body)));

    const def = getNotificationDefinition("SYNC_FAILED")!;
    check("registry: legacy row (no state) renders the sync-failed copy", def.render({ plaidItemId: "i", institutionName: "Chase" }).title === "We couldn't sync Chase");
    check("registry: empty data still renders a title + href", def.render({}).title === "We couldn't sync your institution" && def.render({}).href === "/dashboard/connections");
    check("registry: dedupe/channels unchanged",
      def.dedupe === "suppress" && def.dedupeKeyTemplate === "SYNC_FAILED:item:{plaidItemId}:open" &&
      JSON.stringify(def.defaultChannels) === JSON.stringify(["IN_APP", "EMAIL"]) && def.category === "FINANCIAL" && def.locked === false);

    // Producer: derives the state from the row's status, passes everything else as before.
    for (const [status, expected] of [["NEEDS_REAUTH", "reauth-required"], ["ERROR", "sync-failed"], ["REVOKED", "disconnected"], [undefined, "sync-failed"]] as const) {
      const selects: unknown[] = [];
      const client: PlaidItemReadClient = {
        plaidItem: {
          async findUnique(args) {
            selects.push(args.select);
            return { userId: "u1", institutionName: "Chase", ...(status ? { status } : {}) };
          },
        },
      };
      const calls: { type: string; userId: string; data?: Record<string, unknown> }[] = [];
      await notifyItemSyncFailed("item_1", {
        itemClient: client,
        createFn: (async (input: { type: string; userId: string; data?: Record<string, unknown> }) => {
          calls.push(input);
          return { status: "created", id: "n1" };
        }) as never,
      });
      check(`producer: status ${status ?? "(absent)"} → connectionState ${expected}`,
        calls.length === 1 && calls[0].type === "SYNC_FAILED" && calls[0].userId === "u1" &&
        JSON.stringify(calls[0].data) === JSON.stringify({ plaidItemId: "item_1", institutionName: "Chase", connectionState: expected }), calls);
      check("producer reads status from the row it already reads", JSON.stringify(selects[0]) === JSON.stringify({ userId: true, institutionName: true, status: true }));
    }
  }

  // ── 5b. owner decision 2026-10-31: no notify for a removal on our side ────
  console.log("5b. user removal mid-sync → no notification; provider revocation still notifies");
  {
    async function produce(status: string, conns: { live: number; removed: number } | "throws" | null) {
      const counted: unknown[] = [];
      const client: PlaidItemReadClient = {
        plaidItem: { async findUnique() { return { userId: "u1", institutionName: "Chase", status }; } },
        ...(conns
          ? {
              accountConnection: {
                async count(args) {
                  counted.push(args.where);
                  if (conns === "throws") throw new Error("connection pool exhausted for owner@example.invalid");
                  return args.where.deletedAt === null ? conns.live : conns.removed;
                },
              },
            }
          : {}),
      };
      const calls: { data?: Record<string, unknown> }[] = [];
      const logs: string[] = [];
      const orig = console.log;
      const origWarn = console.warn;
      const warns: string[] = [];
      console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
      console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
      try {
        await notifyItemSyncFailed("item_9", {
          itemClient: client,
          createFn: (async (input: { data?: Record<string, unknown> }) => { calls.push(input); return { status: "created", id: "n" }; }) as never,
        });
      } finally { console.log = orig; console.warn = origWarn; }
      return { calls, logs, counted, warns };
    }
    const userRemoved = await produce("REVOKED", { live: 0, removed: 2 });
    check("user removal mid-sync (REVOKED, every connection soft-deleted) → no notification", userRemoved.calls.length === 0, userRemoved.calls);
    check("…recorded as a suppression with a reason and no PII",
      userRemoved.logs.length === 1 && /suppressed for item item_9 \(REVOKED\): removed by the user/.test(userRemoved.logs[0]) && !/Chase|u1/.test(userRemoved.logs[0]), userRemoved.logs);
    check("…the marker reads live AND soft-deleted connections of THIS item",
      JSON.stringify(userRemoved.counted) === JSON.stringify([{ plaidItemDbId: "item_9", deletedAt: null }, { plaidItemDbId: "item_9", deletedAt: { not: null } }]), userRemoved.counted);
    const provider = await produce("REVOKED", { live: 2, removed: 0 });
    check("provider revocation (REVOKED, connections still live) → notifies with the disconnected copy",
      provider.calls.length === 1 && provider.calls[0].data?.connectionState === "disconnected" &&
      getNotificationDefinition("SYNC_FAILED")!.render(provider.calls[0].data!).title === "Chase is disconnected");
    const partial = await produce("REVOKED", { live: 1, removed: 3 });
    check("REVOKED with a live connection left → still notifies (not a full removal)", partial.calls.length === 1);
    const noRows = await produce("REVOKED", { live: 0, removed: 0 });
    check("REVOKED with no connection rows at all → still notifies (no evidence of a removal)", noRows.calls.length === 1);
    const noReader = await produce("REVOKED", null);
    check("a client that cannot read connections never suppresses (conservative)", noReader.calls.length === 1);
    // Any state: disconnect.ts soft-deletes the connections before itemRemove
    // and the REVOKED write, so a failure in that window reads ERROR / NEEDS_REAUTH.
    for (const [status, state] of [["ERROR", "sync-failed"], ["NEEDS_REAUTH", "reauth-required"]] as const) {
      const removedAll = await produce(status, { live: 0, removed: 2 });
      check(`${status} with every connection soft-deleted → suppressed (a bank the user removed)`,
        removedAll.calls.length === 0 && removedAll.logs.some((l) => l.includes(`suppressed for item item_9 (${status})`)), removedAll);
      const live = await produce(status, { live: 1, removed: 0 });
      check(`${status} with a live connection → notifies (${state})`,
        live.calls.length === 1 && live.calls[0].data?.connectionState === state, live);
      const mixed = await produce(status, { live: 1, removed: 2 });
      check(`${status} with one live + removed connections → notifies`, mixed.calls.length === 1);
      const empty = await produce(status, { live: 0, removed: 0 });
      check(`${status} with no connection rows at all → notifies`, empty.calls.length === 1);
    }
    for (const status of ["ERROR", "NEEDS_REAUTH", "REVOKED"]) {
      const t = await produce(status, "throws");
      check(`${status}: a failing removal check FAILS OPEN → notifies`, t.calls.length === 1, t);
      check(`${status}: …with a redacted warning (item id, no address)`,
        t.warns.length === 1 && t.warns[0].includes("removal check failed for item item_9; notifying") && !t.warns[0].includes("owner@example.invalid") && !t.warns[0].includes("pool exhausted"), t.warns);
    }
  }

  // ── 6. no token in logs / error results ────────────────────────────────────
  console.log("6. no token in logs or error results");
  {
    const TOKEN = "a".repeat(64);
    const logged: string[] = [];
    const orig = { error: console.error, warn: console.warn, log: console.log };
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    console.warn = console.error;
    let res;
    try {
      res = await sendEmail("password-reset", "x@example.invalid", { resetUrl: `javascript:alert(1)//?token=${TOKEN}` });
    } finally {
      console.error = orig.error; console.warn = orig.warn;
    }
    check("a refused render is an error result", res?.status === "error");
    check("the error result never echoes the token", !String(res?.error).includes(TOKEN));
    check("nothing logged carries the token", logged.every((l) => !l.includes(TOKEN)), logged);
    // Every sender's console lines name only the provider error — never a URL / token variable.
    const senders = [
      "app/api/auth/forgot-password/route.ts", "app/api/auth/register/route.ts", "lib/email/verification.ts",
      "app/api/user/email/request/route.ts", "app/api/auth/reset-password/route.ts", "app/api/user/export/route.ts",
      "app/api/spaces/[id]/invite/route.ts", "lib/platform/growth/invitation-issue.ts", "lib/security/anomaly-alerts.ts",
    ];
    for (const f of senders) {
      const lines = readFileSync(f, "utf8").split("\n").filter((l) => /console\.(log|error|warn|info)\(/.test(l));
      check(`${f}: no console line references a link or token`, lines.every((l) => !/(resetUrl|verifyUrl|confirmUrl|inviteUrl|rawToken|token\b)/.test(l)), lines);
    }
  }

  // ── 6b. the export alert is built inside the non-throwing send ────────────
  console.log("6b. a malformed app base never fails the export");
  {
    const { sendSecurityAlert, SECURITY_ALERT_BUILD_ERROR } = await import("@/lib/email/send-security-alert");
    let sent = 0;
    const spy = (async () => { sent++; return { status: "captured", provider: "capture" }; }) as never;
    const bad = await sendSecurityAlert("x@example.invalid", () => alerts.dataExportedAlert(new Date(), "not a url ?token=secret-ish"), spy)
      .catch(() => ({ status: "threw", provider: "none", error: "threw" as string | undefined }));
    check("builder throw → error result (no exception)", bad.status === "error" && bad.provider === "none");
    check("…with the fixed, redacted message", bad.error === SECURITY_ALERT_BUILD_ERROR && !String(bad.error).includes("secret-ish"));
    check("…and nothing is sent", sent === 0);
    const ok = await sendSecurityAlert("x@example.invalid", () => alerts.dataExportedAlert(new Date(), "https://app.fourthmeridian.com"), spy);
    check("a valid base still sends", ok.status === "captured" && sent === 1);
    const route = readFileSync("app/api/user/export/route.ts", "utf8");
    check("the export route builds the alert only inside sendSecurityAlert",
      /sendSecurityAlert\(dbUser\.email,\s*\(\)\s*=>\s*\n?\s*dataExportedAlert\(/.test(route) && !/\.\.\.dataExportedAlert\(/.test(route));
    check("the export route records the email status, then audits (order unchanged)",
      route.indexOf("sendSecurityAlert(") < route.indexOf("AuditAction.DATA_EXPORTED") && /emailStatus = emailResult\.status/.test(route));
  }

  // ── 7. the security variant carries no promotional block ───────────────────
  console.log("7. security variant: no marketing blocks");
  {
    check("the design system refuses an info panel in a security email", throws(() => renderEmail({
      subject: "s", preheader: "p", footer: { reason: "r" }, brand: BRAND, variant: "security",
      blocks: [{ kind: "security", text: "x" }, { kind: "info", items: ["promo"] }],
    })));
    const sec = previewCases().filter((c) => SECURITY_VARIANT_SLUGS.some((p) => c.slug.startsWith(p)) && c.slug !== "security-alert--security-ops-anomaly");
    check("security-variant cases exist (reset, verify, change, every account alert)", sec.length >= 14, sec.length);
    for (const c of sec) {
      const html = getTemplate(c.template).render(c.data as never).html ?? "";
      check(`${c.slug}: carries the restrained security panel`, html.includes("fm-panel fm-edge-muted"));
      check(`${c.slug}: no info panel / next-steps / promo`, !html.includes('class="fm-panel fm-edge"') && !/What happens next|Get Started|Connect your accounts/.test(html));
      check(`${c.slug}: no red alarm styling`, !/#(?:f00|ff0000|dc2626|ef4444|b91c1c)\b|color:\s*red/i.test(html));
    }
    const exp = renderSecurityAlert(alerts.dataExportedAlert(new Date("2026-10-31T15:04:00Z"), "https://app.fourthmeridian.com"), { brand: BRAND });
    check("export alert: labelled UTC timestamp", exp.text.includes("Saturday, October 31, 2026 at 3:04 PM UTC"));
    check("export alert: Review account security CTA", exp.text.includes("Review account security:\nhttps://app.fourthmeridian.com/dashboard/settings/security"));
    check("export alert: never claims an incident", !/breach|compromis|incident|attack|suspicious/i.test(exp.text));
    check("export alert: guidance for unrecognised activity", /don't recognize this activity/.test(exp.text));
    check("default guidance is the pre-migration line", renderSecurityAlert({ title: "t", message: "m" }, { brand: BRAND }).text.includes(DEFAULT_SECURITY_GUIDANCE));
    const ops = renderSecurityAlert(alerts.securityOpsAnomalyAlert({
      key: "identifier:victim@example.invalid", title: "Repeated failed sign-in attempts", message: "m", count: 8, windowMinutes: 15, threshold: 5,
    }), { brand: BRAND });
    check("Security Ops email withholds the raw identifier", !ops.text.includes("victim@example.invalid") && !ops.html.includes("victim@example.invalid") && ops.text.includes("Signal: identifier"));
    check("Security Ops email withholds a raw IP", !renderSecurityAlert(alerts.securityOpsAnomalyAlert({
      key: "ip:203.0.113.9", title: "t", message: "m", count: 1, windowMinutes: 1, threshold: 1,
    }), { brand: BRAND }).text.includes("203.0.113.9"));
    check("Security Ops email has no account-holder guidance", !ops.text.includes(DEFAULT_SECURITY_GUIDANCE));
  }

  console.log(failures === 0 ? "\nAll email migration checks passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
