/**
 * lib/email/preview.test.ts
 *
 * The preview tool (scripts/email-preview.ts → lib/email/preview.ts) renders
 * synthetic, non-redeemable emails and sends ONLY to the exact local allowlist
 * address. I/O is injected: nothing here writes a file or sends anything.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/email/preview.test.ts
 */

import { PREVIEW_TOKEN, previewCases, runEmailPreview, type PreviewIo } from "@/lib/email/preview";
import { wholeDaysBetween } from "@/lib/email/design/datetime";
import type { EmailTemplateName } from "@/lib/email/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

function fakeIo() {
  const files = new Map<string, string>();
  const sends: { template: EmailTemplateName; to: string }[] = [];
  const io: PreviewIo = {
    mkdir: () => {},
    writeFile: (p, c) => { files.set(p, c); },
    send: async (template, to) => { sends.push({ template, to }); return { status: "captured", provider: "capture" }; },
    log: () => {},
  };
  return { io, files, sends };
}

async function refused(argv: string[], env: Record<string, string | undefined>) {
  const f = fakeIo();
  let error = "";
  try { await runEmailPreview(argv, env, f.io); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  return { ...f, error };
}

async function main() {
  console.log("1. --send refuses a non-allowlisted recipient (nothing written, nothing sent)");
  const ALLOWED = "owner-inbox@example.invalid";
  for (const [label, argv, env] of [
    ["allowlist unset", ["--out", "/x", "--send", "--to", ALLOWED], {}],
    ["different address", ["--out", "/x", "--send", "--to", "someone-else@example.invalid"], { EMAIL_PREVIEW_ALLOWED_TO: ALLOWED }],
    ["case-different address (exact match only)", ["--out", "/x", "--send", "--to", ALLOWED.toUpperCase()], { EMAIL_PREVIEW_ALLOWED_TO: ALLOWED }],
    ["superstring address", ["--out", "/x", "--send", "--to", `${ALLOWED}.evil.test`], { EMAIL_PREVIEW_ALLOWED_TO: ALLOWED }],
    ["--send without --to", ["--out", "/x", "--send"], { EMAIL_PREVIEW_ALLOWED_TO: ALLOWED }],
    ["empty allowlist", ["--out", "/x", "--send", "--to", ""], { EMAIL_PREVIEW_ALLOWED_TO: "" }],
  ] as [string, string[], Record<string, string>][]) {
    const r = await refused(argv, env);
    check(`${label}: refused`, /refusing to send/.test(r.error), r.error);
    check(`${label}: sent nothing, wrote nothing`, r.sends.length === 0 && r.files.size === 0, [r.sends.length, r.files.size]);
    check(`${label}: error names neither address`, !r.error.includes("@"), r.error);
  }

  console.log("2. the allowlisted address may send; render-only never sends");
  {
    const f = fakeIo();
    const res = await runEmailPreview(["--out", "/out/", "--send", "--to", ALLOWED], { EMAIL_PREVIEW_ALLOWED_TO: ALLOWED }, f.io);
    check("exact match sends every case to that address only", res.sent === previewCases().length && f.sends.every((s) => s.to === ALLOWED && s.template === "beta-invite"), f.sends.length);
    const g = fakeIo();
    const r2 = await runEmailPreview(["--out", "/out"], { EMAIL_PREVIEW_ALLOWED_TO: ALLOWED }, g.io);
    check("render-only: no send even with the allowlist set", g.sends.length === 0 && r2.sent === 0);
    check("render-only: .html + .txt per case", g.files.size === previewCases().length * 2, g.files.size);
    const r3 = await refused(["--to", ALLOWED, "--out", "/out"], { EMAIL_PREVIEW_ALLOWED_TO: ALLOWED });
    check("--to without --send is rejected", /only meaningful with --send/.test(r3.error) && r3.sends.length === 0, r3.error);
    const r4 = await refused([], {});
    check("--out is required", /--out/.test(r4.error), r4.error);
  }

  console.log("3. preview content is synthetic and non-redeemable");
  {
    const g = fakeIo();
    await runEmailPreview(["--out", "/out"], {}, g.io);
    const all = [...g.files.entries()];
    check("every file carries the non-redeemable token", all.every(([, c]) => c.includes(`invite=${PREVIEW_TOKEN}`)));
    check("no 64-hex (real-shaped) token anywhere", all.every(([, c]) => !/[0-9a-f]{64}/i.test(c)));
    check("every subject is [PREVIEW]-prefixed", all.filter(([p]) => p.endsWith(".html")).every(([, c]) => c.includes("<title>[PREVIEW] Your Fourth Meridian beta access is approved</title>")));
    const days = previewCases().map((c) => wholeDaysBetween(c.data.issuedAt, c.data.expiresAt));
    check("variants cover 1/7/14/30 days, named and unnamed", [1, 7, 14, 30].every((d) => days.includes(d))
      && previewCases().some((c) => c.data.recipientName) && previewCases().some((c) => !c.data.recipientName));
    check("the only address in the content is the published support mailbox", all.every(([, c]) => (c.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).every((a) => a === "support@fourthmeridian.com")));
  }

  console.log(failures === 0 ? "\nAll email preview checks passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
