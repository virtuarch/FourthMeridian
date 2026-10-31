/**
 * lib/email/recipient-guard.test.ts — the NON-PRODUCTION RECIPIENT GUARD
 *
 * Owner requirement (2026-10-31): Preview must never email an unauthorized
 * recipient. Comms Center contract §O-4: outside Production, only allowlisted
 * recipients; everything else CAPTURED / ENVIRONMENT_GUARD.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/email/recipient-guard.test.ts
 *
 * No network, no real provider: the chokepoint is built with createEmailSender
 * over a FAKE provider that records what it was handed, so "sent to the
 * provider" is observed directly. Covers: production sends to anyone · preview
 * with an allowlist sends to the listed address only · preview captures others
 * · unset/empty allowlist captures all · unknown env captures (incl. off-Vercel
 * NODE_ENV=production) · case/whitespace normalisation · no full address in the
 * log line · test mode + no key unchanged · every send path reaches the
 * provider only through send.ts · the notification channel and the retry job
 * treat "captured" as a non-failure that is never retried.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createEmailSender, type EmailSendEnv } from "@/lib/email/send";
import {
  decideRecipient,
  describeGuardedRecipient,
  emailEnvironment,
  parseNonprodAllowlist,
} from "@/lib/email/recipient-guard";
import type { EmailMessage, EmailProvider, EmailResult } from "@/lib/email/types";
import { retryNotifications, type NotificationRetryClient } from "@/jobs/retry-notifications";
import type { ChannelAdapter, ChannelMessage } from "@/lib/notifications/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const PROD: EmailSendEnv = { VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production", RESEND_API_KEY: "re_fake" };
const PREVIEW: EmailSendEnv = { VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production", RESEND_API_KEY: "re_fake" };

function harness(env: EmailSendEnv) {
  const provided: EmailMessage[] = [];
  const captured: EmailMessage[] = [];
  const logs: string[] = [];
  const levels: string[] = [];
  const provider: EmailProvider = {
    name: "fake-provider",
    async send(m) { provided.push(m); return { status: "sent", provider: "fake-provider", id: "id_1" }; },
  };
  const capture: EmailProvider = {
    name: "capture",
    async send(m) { captured.push(m); return { status: "captured", provider: "capture" }; },
  };
  const send = createEmailSender({ env, provider, capture, log: (l, lvl) => { logs.push(l); levels.push(lvl); } });
  return { send, provided, captured, logs, levels };
}

const isGuarded = (r: EmailResult) => r.status === "captured" && r.provider === "none" && r.reason === "ENVIRONMENT_GUARD";

async function main() {
  console.log("1. Production sends to anyone (unchanged)");
  {
    const h = harness({ ...PROD });
    const r = await h.send("smoke", "anyone@example.com", { note: "x" });
    check("production → provider, status sent", r.status === "sent" && h.provided.length === 1 && h.provided[0].to === "anyone@example.com", r);
    const h2 = harness({ ...PROD, EMAIL_NONPROD_ALLOWLIST: "only@example.com" });
    await h2.send("smoke", "someone-else@example.com");
    check("production ignores the allowlist entirely", h2.provided.length === 1 && h2.logs.length === 0);
  }

  console.log("2. Preview with an allowlist sends to the listed address only");
  {
    const h = harness({ ...PREVIEW, EMAIL_NONPROD_ALLOWLIST: "owner@example.com,qa@example.com" });
    const ok = await h.send("smoke", "owner@example.com");
    check("listed address → provider, sent", ok.status === "sent" && h.provided.map((m) => m.to).join() === "owner@example.com", ok);
    const no = await h.send("smoke", "customer@example.org");
    check("unlisted address → captured/none/ENVIRONMENT_GUARD", isGuarded(no), no);
    check("unlisted address never reached the provider", h.provided.length === 1 && !h.provided.some((m) => m.to === "customer@example.org"));
    check("guarded send is not put in the capture transport either", h.captured.length === 0);
    check("a superstring of a listed address is not a match", isGuarded(await h.send("smoke", "owner@example.com.evil.test")));
    check("a substring of a listed address is not a match", isGuarded(await h.send("smoke", "wner@example.com")));
  }

  console.log("3. Unset or empty allowlist outside production captures everything");
  for (const [label, list] of [["unset", undefined], ["empty", ""], ["whitespace/commas only", " , ,"]] as const) {
    const h = harness({ ...PREVIEW, EMAIL_NONPROD_ALLOWLIST: list });
    const r = await h.send("smoke", "owner@example.com");
    check(`${label} allowlist → captured, provider untouched`, isGuarded(r) && h.provided.length === 0, r);
  }

  console.log("4. Unknown / unset environment is non-production (fail closed)");
  const unknownEnvs: [string, EmailSendEnv][] = [
    ["Vercel, VERCEL_ENV unset", { VERCEL: "1", RESEND_API_KEY: "re_fake" }],
    ["Vercel, VERCEL_ENV unexpected", { VERCEL: "1", VERCEL_ENV: "staging", RESEND_API_KEY: "re_fake" }],
    // Exact comparison only — a loosened trim/lower-case would accept these.
    ["Vercel, VERCEL_ENV 'production ' (trailing space)", { VERCEL: "1", VERCEL_ENV: "production ", RESEND_API_KEY: "re_fake" }],
    ["Vercel, VERCEL_ENV 'Production' (capitalised)", { VERCEL: "1", VERCEL_ENV: "Production", RESEND_API_KEY: "re_fake" }],
    ["Vercel, VERCEL_ENV ' production' (leading space)", { VERCEL: "1", VERCEL_ENV: " production", RESEND_API_KEY: "re_fake" }],
    ["Vercel development", { VERCEL: "1", VERCEL_ENV: "development", RESEND_API_KEY: "re_fake" }],
    ["off Vercel, NODE_ENV=production (local next start / CI / scripts)", { NODE_ENV: "production", RESEND_API_KEY: "re_fake" }],
    ["off Vercel, VERCEL_ENV=production but no VERCEL=1", { VERCEL_ENV: "production", RESEND_API_KEY: "re_fake" }],
    ["off Vercel, nothing set", { RESEND_API_KEY: "re_fake" }],
    ["local development", { NODE_ENV: "development", RESEND_API_KEY: "re_fake" }],
  ];
  for (const [label, env] of unknownEnvs) {
    const h = harness(env);
    const r = await h.send("smoke", "anyone@example.com");
    check(`${label} → captured`, isGuarded(r) && h.provided.length === 0, { r, env: emailEnvironment(env) });
  }
  check("only VERCEL=1 + VERCEL_ENV=production classifies as production",
    emailEnvironment(PROD) === "production" && unknownEnvs.every(([, e]) => emailEnvironment(e) !== "production"));

  console.log("4b. An unknown Vercel environment captures LOUDLY (console.warn, fixed text)");
  {
    const h = harness({ VERCEL: "1", VERCEL_ENV: "Production", RESEND_API_KEY: "re_fake" });
    await h.send("smoke", "anyone@example.com");
    check("unknown Vercel env → warn level + the fixed message",
      h.levels.join() === "warn" && h.logs[0]?.includes("email guard: unknown Vercel environment, capturing"), { l: h.logs, v: h.levels });
    const p = harness({ ...PREVIEW });
    await p.send("smoke", "anyone@example.com");
    check("Preview capture stays at info (not the misconfiguration warning)",
      p.levels.join() === "info" && !p.logs[0]?.includes("unknown Vercel environment"), { l: p.logs, v: p.levels });
    const off = harness({ NODE_ENV: "production", RESEND_API_KEY: "re_fake" });
    await off.send("smoke", "anyone@example.com");
    check("off-Vercel unknown stays at info (no Vercel runtime to misconfigure)", off.levels.join() === "info");
    const spied: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { spied.push(a.map(String).join(" ")); };
    try {
      await createEmailSender({ env: { VERCEL: "1", VERCEL_ENV: "production ", RESEND_API_KEY: "re_fake" }, provider: { name: "p", send: async () => ({ status: "sent", provider: "p" }) }, capture: { name: "c", send: async () => ({ status: "captured", provider: "capture" }) } })("smoke", "a@example.com");
    } finally { console.warn = orig; }
    check("default wiring sends the warning to console.warn", spied.length === 1 && spied[0].includes("email guard: unknown Vercel environment, capturing") && !spied[0].includes("a@example.com"), spied);
  }

  console.log("4c. Unicode case-folding cannot smuggle a raw address to the provider");
  {
    const KELVIN = "\u212A"; // KELVIN SIGN — toLowerCase() → "k"
    const ANGSTROM = "\u212B"; // ANGSTROM SIGN — toLowerCase() → "å"
    check("precondition: the Kelvin sign really folds to ASCII k", `${KELVIN}`.toLowerCase() === "k");
    const h = harness({ ...PREVIEW, EMAIL_NONPROD_ALLOWLIST: "kelvin@example.com" });
    const r = await h.send("smoke", `${KELVIN}elvin@example.com`);
    check("a Kelvin-sign address is captured outside production (non-ASCII refused)", isGuarded(r) && h.provided.length === 0, r);
    const a = harness({ ...PREVIEW, EMAIL_NONPROD_ALLOWLIST: "\u00e5se@example.com" });
    check("an Angstrom-sign address is captured, and a non-ASCII entry admits nothing",
      isGuarded(await a.send("smoke", `${ANGSTROM}se@example.com`)) && isGuarded(await a.send("smoke", "\u00e5se@example.com")) && a.provided.length === 0);
    check("pure decision: non-ASCII refused even when it folds onto an entry",
      decideRecipient(`${KELVIN}elvin@example.com`, { ...PREVIEW, EMAIL_NONPROD_ALLOWLIST: "kelvin@example.com" }).deliver === false);
    const m = harness({ ...PREVIEW, EMAIL_NONPROD_ALLOWLIST: "owner@example.com" });
    await m.send("smoke", "  OWNER@Example.com ");
    check("an allowed non-production send is addressed to the MATCHED ENTRY, not the raw string",
      m.provided.length === 1 && m.provided[0].to === "owner@example.com", m.provided.map((x) => x.to));
    const d = decideRecipient(" Owner@Example.COM", { ...PREVIEW, EMAIL_NONPROD_ALLOWLIST: "owner@example.com" });
    check("parse: a non-ASCII allowlist entry is dropped (defence in depth)",
      [...parseNonprodAllowlist("\u00e5se@example.com, a@b.c, \u212Aelvin@example.com")].join("|") === "a@b.c");
    check("pure decision returns the canonical entry", d.deliver === true && d.to === "owner@example.com", d);
    const pr = harness({ ...PROD });
    await pr.send("smoke", `${KELVIN}elvin@example.com`);
    check("production is unchanged: the caller's address goes through verbatim", pr.provided[0]?.to === `${KELVIN}elvin@example.com`);
  }

  console.log("5. Case and whitespace normalisation (both sides)");
  {
    const h = harness({ ...PREVIEW, EMAIL_NONPROD_ALLOWLIST: "  Owner@Example.COM , qa@example.com  " });
    check("upper-case recipient matches a mixed-case entry", (await h.send("smoke", "OWNER@example.com")).status === "sent");
    check("padded recipient matches", (await h.send("smoke", "  qa@example.com ")).status === "sent");
    check("parse: trimmed, lower-cased, empties dropped",
      [...parseNonprodAllowlist(" A@B.c ,, d@e.f ,")].join("|") === "a@b.c|d@e.f");
    check("pure decision agrees", decideRecipient("A@B.C", { ...PREVIEW, EMAIL_NONPROD_ALLOWLIST: "a@b.c" }).deliver === true);
  }

  console.log("6. The log line never carries the full address");
  {
    const ADDRESS = "private.person+tag@example.org";
    const h = harness({ ...PREVIEW, EMAIL_NONPROD_ALLOWLIST: "owner@example.com" });
    const spied: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
    const spy = (...a: unknown[]) => { spied.push(a.map(String).join(" ")); };
    console.log = spy; console.error = spy; console.warn = spy; console.info = spy; console.debug = spy;
    try {
      await h.send("password-reset", ADDRESS, { resetUrl: "https://app.example.test/reset-password?token=abc" });
      // The real wiring logs through console.info — exercise it too.
      await createEmailSender({ env: { ...PREVIEW }, provider: { name: "p", send: async () => ({ status: "sent", provider: "p" }) }, capture: { name: "c", send: async () => ({ status: "captured", provider: "capture" }) } })("smoke", ADDRESS);
    } finally { Object.assign(console, orig); }
    const all = [...h.logs, ...spied];
    check("one redacted line per guarded send", h.logs.length === 1 && spied.filter((l) => l.includes("non-production recipient guard")).length === 1, all);
    check("line names template + environment + domain + hash",
      /template=password-reset/.test(h.logs[0] ?? "") && /environment=preview/.test(h.logs[0] ?? "") && /domain=example\.org/.test(h.logs[0] ?? "") && /hash=[0-9a-f]{12}/.test(h.logs[0] ?? ""), h.logs);
    check("no log line contains the address or its local part", !all.some((l) => l.includes(ADDRESS) || l.includes("private.person")), all);
    check("no log line contains the template's link", !all.some((l) => l.includes("token=abc")), all);
    check("describeGuardedRecipient is stable across case/whitespace", describeGuardedRecipient(" A@B.c ") === describeGuardedRecipient("a@b.c"));
  }

  console.log("7. Test mode and no-key behaviour unchanged");
  {
    const t = harness({ ...PROD, NODE_ENV: "test" });
    const r = await t.send("smoke", "a@example.com");
    check("test mode → capture transport even in 'production' with a key", r.provider === "capture" && t.provided.length === 0 && t.captured.length === 1);
    const n = harness({ VERCEL: "1", VERCEL_ENV: "preview" });
    const r2 = await n.send("smoke", "a@example.com");
    check("no key → capture transport (provider 'capture'), nothing provided", r2.provider === "capture" && n.provided.length === 0);
  }

  console.log("8. Every send path reaches the provider only through lib/email/send.ts");
  {
    const roots = ["app", "lib", "jobs", "scripts", "components"];
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        if (f === "node_modules" || f.startsWith(".")) continue;
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs|js|cjs)$/.test(f) && !/\.test\.ts$/.test(f)) files.push(p);
      }
    };
    roots.forEach(walk);
    const importers = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, "utf8")));
    check("the Resend SDK is imported only by the adapter",
      importers(/from\s+["']resend["']/).join() === "lib/email/providers/resend.ts", importers(/from\s+["']resend["']/));
    check("the Resend adapter is imported only by send.ts (+ env.ts docs)",
      importers(/["']@\/lib\/email\/providers\/resend["']/).every((f) => f === "lib/email/send.ts"), importers(/["']@\/lib\/email\/providers\/resend["']/));
    check("no direct HTTP call to the Resend API anywhere", importers(/api\.resend\.com/).length === 0, importers(/api\.resend\.com/));
    const channel = readFileSync("lib/notifications/channels/email.ts", "utf8");
    check("notification EMAIL channel delivers via sendEmail", /sendEmail\(\s*"notification"/.test(channel));
    const retry = readFileSync("jobs/retry-notifications.ts", "utf8");
    check("retry job re-delivers via the same channel adapter (no own transport)",
      /emailNotificationAdapter/.test(retry) && !/providers\//.test(retry) && !/from\s+["']resend["']/.test(retry));
    const preview = readFileSync("scripts/email-preview.ts", "utf8");
    check("the preview script sends via sendEmail", /lib\/email\/send"\)\)\.sendEmail/.test(preview));
    const send = readFileSync("lib/email/send.ts", "utf8");
    check("send.ts calls the provider exactly once, after the guard",
      (send.match(/deps\.provider\.send\(/g) ?? []).length === 1 &&
      send.indexOf("decideRecipient(to, env)") > 0 && send.indexOf("decideRecipient(to, env)") < send.indexOf("deps.provider.send("));
    check("the exported sendEmail is built over process.env + the real adapters",
      /export const sendEmail: SendEmailFn = createEmailSender\(\{\s*env: process\.env as EmailSendEnv,\s*provider: resendAdapter,/.test(send));
  }

  console.log("9. The retry job never retries a captured delivery");
  {
    type Row = { id: string; status: string; attempts: number; provider: string | null; error: string | null };
    const rows: Row[] = [
      { id: "cap", status: "captured", attempts: 1, provider: "none", error: null },
      { id: "err", status: "error", attempts: 1, provider: "resend", error: "boom" },
    ];
    const notification = {
      userId: "u1", type: "SYNC_FAILED", category: "FINANCIAL", priority: "HIGH", title: "t", body: null, href: null,
      metadata: null, readAt: null, archivedAt: null, expiresAt: null, user: { email: "u1@example.com" },
    };
    const client: NotificationRetryClient = {
      notificationDelivery: {
        async findMany({ where }) {
          return rows.filter((r) => r.status === where.status && r.attempts < where.attempts.lt).map((r) => ({ id: r.id, attempts: r.attempts, notification }));
        },
        async updateMany({ where }) {
          const r = rows.find((x) => x.id === where.id && x.status === where.status && x.attempts === where.attempts);
          if (!r) return { count: 0 };
          r.attempts++; return { count: 1 };
        },
        async count({ where }) { return rows.some((r) => r.id === where.id) ? 1 : 0; },
        async update({ where, data }) { Object.assign(rows.find((r) => r.id === where.id)!, data); return {}; },
      },
    };
    const delivered: ChannelMessage[] = [];
    // The preview outcome: the guard captured the re-delivery.
    const adapter: ChannelAdapter = { channel: "EMAIL", name: "email", async deliver(m) { delivered.push(m); return { status: "captured", provider: "none" }; } };
    const first = await retryNotifications(client, adapter, new Date("2026-10-31T07:30:00Z"));
    check("first pass: only the error row is retried (captured row never selected)", first.examined === 1 && first.retried === 1 && delivered.length === 1);
    check("a guarded re-delivery closes the row as captured (not error)", rows.find((r) => r.id === "err")!.status === "captured");
    check("the original captured row is untouched", rows.find((r) => r.id === "cap")!.attempts === 1);
    const second = await retryNotifications(client, adapter, new Date("2026-10-31T07:31:00Z"));
    check("second pass: nothing examined, nothing re-sent", second.examined === 0 && delivered.length === 1, second);
    check("captured is not counted as still failing", first.stillFailing === 0);
  }

  console.log(failures === 0 ? "\nAll recipient-guard checks passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
