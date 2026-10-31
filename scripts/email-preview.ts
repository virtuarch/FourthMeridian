/**
 * scripts/email-preview.ts
 *
 * Render every design-system email template (synthetic data, non-redeemable
 * token `preview-not-redeemable`, "[PREVIEW]" subjects) to .html + .txt files:
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/email-preview.ts --out <dir>
 *
 * Optional real send, for eyeballing in an inbox:
 *
 *   ... scripts/email-preview.ts --out <dir> --send --to <addr>
 *
 * The send happens ONLY when <addr> exactly equals the env var
 * EMAIL_PREVIEW_ALLOWED_TO, which is set locally and NEVER committed (this repo
 * is public). Otherwise the script refuses before writing or sending anything.
 * No database access; rendering makes no network call. Logic: lib/email/preview.ts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { runEmailPreview } from "@/lib/email/preview";

async function main(): Promise<void> {
  const { written, sent } = await runEmailPreview(process.argv.slice(2), process.env, {
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    writeFile: (file, contents) => writeFileSync(file, contents, "utf8"),
    // Loaded lazily: a render-only run never imports the send chokepoint.
    send: async (template, to, data) => (await import("@/lib/email/send")).sendEmail(template, to, data),
    log: (line) => console.log(line),
  });
  for (const f of written) console.log(f);
  if (sent > 0) console.log(`sent ${sent} preview email(s)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
