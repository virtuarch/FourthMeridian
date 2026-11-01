/**
 * lib/email/preview.test.ts
 *
 * The preview tool (scripts/email-preview.ts → lib/email/preview.ts) renders
 * synthetic, non-redeemable emails and sends ONLY to the exact local allowlist
 * address. I/O is injected: nothing here writes a file or sends anything.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/email/preview.test.ts
 */

import { PREVIEW_TOKEN, filterPreviewCases, previewCases, runEmailPreview, type PreviewIo } from "@/lib/email/preview";
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
  const logs: string[] = [];
  const io: PreviewIo = {
    mkdir: () => {},
    writeFile: (p, c) => { files.set(p, c); },
    send: async (template, to) => { sends.push({ template, to }); return { status: "captured", provider: "capture" }; },
    log: (line) => { logs.push(line); },
  };
  return { io, files, sends, logs };
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
    check("exact match sends every case to that address only", res.sent === previewCases().length && f.sends.every((s) => s.to === ALLOWED), f.sends.length);
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
    const tokenSlugs = ["beta-invite--", "password-reset", "email-verification", "email-change--"];
    const tokenFiles = all.filter(([p]) => tokenSlugs.some((t) => p.startsWith(`/out/${t}`)));
    check("token emails exist for every token template", tokenSlugs.every((t) => tokenFiles.some(([p]) => p.startsWith(`/out/${t}`))));
    check("every token email carries ONLY the non-redeemable token", tokenFiles.every(([, c]) => c.includes(`=${PREVIEW_TOKEN}`) && !/token=(?!preview-not-redeemable)[^&\s"<]+/.test(c)));
    check("no 64-hex (real-shaped) token anywhere", all.every(([, c]) => !/[0-9a-f]{64}/i.test(c)));
    const htmls = all.filter(([p]) => p.endsWith(".html"));
    check("every subject is [PREVIEW]-prefixed", htmls.every(([, c]) => /<title>\[PREVIEW\] [^<]+<\/title>/.test(c)));
    check("request variants use the approval subject", htmls.filter(([p]) => p.includes("--request--")).every(([, c]) => c.includes("<title>[PREVIEW] Your Fourth Meridian beta access is approved</title>")));
    check("direct variants use the invitation subject", htmls.filter(([p]) => p.includes("--direct--")).every(([, c]) => c.includes("<title>[PREVIEW] You&#39;re invited to the Fourth Meridian beta</title>")));
    const beta = previewCases().filter((c) => c.template === "beta-invite");
    check("both origins are previewed", beta.some((c) => c.data.origin === "request") && beta.some((c) => c.data.origin === "direct"));
    const days = beta.map((c) => wholeDaysBetween(c.data.issuedAt as Date, c.data.expiresAt as Date));
    check("variants cover 1/7/14/30 days, named and unnamed", [1, 7, 14, 30].every((d) => days.includes(d))
      && beta.some((c) => c.data.recipientName) && beta.some((c) => !c.data.recipientName));
    check("one connection-attention case per real state", ["sync-failed", "reauth-required", "disconnected"].every((s) => previewCases().some((c) => c.slug === `notification--connection-${s}`)));
    check("logs carry no token or link", g.logs.every((l) => !l.includes(PREVIEW_TOKEN) && !l.includes("http")), g.logs);
    check("the only address in the content is the published support mailbox", all.every(([, c]) => (c.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).every((a) => a === "support@fourthmeridian.com" || a.endsWith("@example.invalid"))));
  }

  console.log("4. --only filters by slug prefix, keeping the allowlist check first");
  {
    const g = fakeIo();
    const r = await runEmailPreview(["--out", "/out", "--only", "password-reset,notification--connection"], {}, g.io);
    const stems = new Set(r.written.map((p) => p.replace(/^\/out\//, "").replace(/\.(html|txt)$/, "")));
    check("--only keeps exactly the matching prefixes", [...stems].every((s) => s.startsWith("password-reset") || s.startsWith("notification--connection")) && stems.has("password-reset") && stems.has("notification--connection-reauth-required"), [...stems]);
    check("--only: matching prefixes only", filterPreviewCases(previewCases(), ["smoke"]).length === 1);
    const none = await refused(["--out", "/out", "--only", "no-such-template"], {});
    check("--only matching nothing is an error", /matched no preview case/.test(none.error) && none.files.size === 0, none.error);
    const empty = await refused(["--out", "/out", "--only", ","], {});
    check("--only with an empty list is an error", /--only needs/.test(empty.error), empty.error);
    const send = await refused(["--out", "/out", "--only", "smoke", "--send", "--to", "x@example.invalid"], {});
    check("--only never bypasses the send allowlist", /refusing to send/.test(send.error) && send.sends.length === 0 && send.files.size === 0, send.error);
  }

  console.log(failures === 0 ? "\nAll email preview checks passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
