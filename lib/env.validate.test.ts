/**
 * lib/env.validate.test.ts  (OPS-1 S6)
 *
 * Standalone tsx script (house pattern). Because lib/env.ts snapshots
 * process.env once at module load, each scenario runs in its own child
 * process (self-spawn with a case argument) — same isolation idea as
 * scripts/run-tests.ts itself.
 *
 * Covers validateEnv():
 *   1. Core keys present (dev) → passes.
 *   2. Missing NEXTAUTH_SECRET (dev) → throws, names the missing var.
 *   3. Production with only core keys → throws, names ALL missing prod-only
 *      vars (NEXTAUTH_URL, NEXT_PUBLIC_APP_URL, RESEND_API_KEY, CRON_SECRET).
 *   4. Production fully configured → passes; RATE_LIMIT_ENABLED=false emits
 *      the loud disabled-in-prod warning (never fatal).
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

const CORE = {
  DATABASE_URL:    "postgresql://t:t@127.0.0.1:5432/t",
  NEXTAUTH_SECRET: "test-secret",
  ENCRYPTION_KEY:  "ab".repeat(32),
};
const PROD_EXTRA = {
  NEXTAUTH_URL:           "https://example.com",
  NEXT_PUBLIC_APP_URL:    "https://example.com",
  RESEND_API_KEY:         "re_test",
  CRON_SECRET:            "cron-test",
  // V25-FINAL-2 (Area A) — production error monitoring is now a required key.
  NEXT_PUBLIC_SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
};

// ── Child mode: import lib/env under the env this process was given ──────────
if (process.argv[2] === "child") {
  (async () => {
    const { validateEnv } = await import("@/lib/env");
    try {
      validateEnv();
      console.log("VALIDATE_OK");
    } catch (err) {
      console.log(`VALIDATE_THREW: ${(err as Error).message.replace(/\n/g, " | ")}`);
    }
  })();
} else {
  // ── Parent mode: run each scenario in an isolated child process ────────────
  let failures = 0;
  function check(name: string, cond: boolean, detail?: string): void {
    if (cond) console.log(`  ✓ ${name}`);
    else {
      failures++;
      console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    }
  }

  const ROOT    = process.cwd();
  const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");
  const PRELOAD = path.join(ROOT, "scripts", "lib", "server-only-preload.cjs");
  const SELF    = path.join(ROOT, "lib", "env.validate.test.ts");

  function run(env: Record<string, string>): string {
    const result = spawnSync(TSX_BIN, ["--require", PRELOAD, SELF, "child"], {
      cwd: ROOT,
      encoding: "utf8",
      // PATH etc. needed by tsx; everything env-validation-relevant is explicit.
      // (cast: Next's ProcessEnv type marks NODE_ENV required, but omitting it
      // for the dev-mode cases is exactly the point of this isolation)
      env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  }

  console.log("1. Dev with core keys set → passes");
  check("VALIDATE_OK", run({ ...CORE, NODE_ENV: "test" }).includes("VALIDATE_OK"));

  console.log("2. Dev missing NEXTAUTH_SECRET → throws and names it");
  const out2 = run({ ...CORE, NEXTAUTH_SECRET: "", NODE_ENV: "test" });
  check("throws", out2.includes("VALIDATE_THREW"), out2.slice(0, 200));
  check("names NEXTAUTH_SECRET", out2.includes("NEXTAUTH_SECRET"));

  console.log("3. Production with only core keys → throws, names all prod-only vars");
  const out3 = run({ ...CORE, NODE_ENV: "production" });
  check("throws", out3.includes("VALIDATE_THREW"), out3.slice(0, 200));
  for (const k of Object.keys(PROD_EXTRA)) {
    check(`names ${k}`, out3.includes(k));
  }

  console.log("4. Production fully configured → passes; RATE_LIMIT_ENABLED=false warns");
  const out4 = run({ ...CORE, ...PROD_EXTRA, NODE_ENV: "production", RATE_LIMIT_ENABLED: "false" });
  check("VALIDATE_OK", out4.includes("VALIDATE_OK"), out4.slice(0, 200));
  check(
    "loud disabled-in-prod warning",
    out4.includes("rate limiting is DISABLED"),
    out4.slice(0, 200),
  );

  // ── V25-FINAL-2 — production Plaid configuration gate ──────────────────────
  const PLAID = { PLAID_CLIENT_ID: "cid", PLAID_SECRET: "sec" };

  console.log("5. Production + Plaid creds + PLAID_ENV=production → passes");
  const out5 = run({ ...CORE, ...PROD_EXTRA, ...PLAID, PLAID_ENV: "production", NODE_ENV: "production" });
  check("VALIDATE_OK", out5.includes("VALIDATE_OK"), out5.slice(0, 300));

  console.log("6. Production + Plaid creds + PLAID_ENV=sandbox → THROWS (no silent sandbox in prod)");
  const out6 = run({ ...CORE, ...PROD_EXTRA, ...PLAID, PLAID_ENV: "sandbox", NODE_ENV: "production" });
  check("throws", out6.includes("VALIDATE_THREW"), out6.slice(0, 300));
  check("names PLAID_ENV / sandbox", out6.includes("PLAID_ENV") && /sandbox/i.test(out6));

  console.log("7. Production + Plaid creds + PLAID_ENV UNSET → THROWS (default-sandbox hazard)");
  const out7 = run({ ...CORE, ...PROD_EXTRA, ...PLAID, NODE_ENV: "production" });
  check("throws", out7.includes("VALIDATE_THREW"), out7.slice(0, 300));
  check("explains it defaults to sandbox", /defaults to sandbox/i.test(out7));

  console.log("8. Production with Plaid DISABLED (no creds) → passes (supported Plaid-off prod mode)");
  const out8 = run({ ...CORE, ...PROD_EXTRA, NODE_ENV: "production" });
  check("VALIDATE_OK", out8.includes("VALIDATE_OK"), out8.slice(0, 300));

  console.log("9. Dev/test + Plaid sandbox → passes (never over-constrain non-prod)");
  const out9 = run({ ...CORE, ...PLAID, PLAID_ENV: "sandbox", NODE_ENV: "test" });
  check("VALIDATE_OK", out9.includes("VALIDATE_OK"), out9.slice(0, 300));

  console.log("10. Production + one Plaid cred only (not fully enabled) → not gated on PLAID_ENV");
  // Only CLIENT_ID present ⇒ isPlaidEnabled is false ⇒ ingestion not expected ⇒ the
  // sandbox gate must not fire (it keys on BOTH creds, matching env.isPlaidEnabled).
  const out10 = run({ ...CORE, ...PROD_EXTRA, PLAID_CLIENT_ID: "cid", PLAID_ENV: "sandbox", NODE_ENV: "production" });
  check("VALIDATE_OK", out10.includes("VALIDATE_OK"), out10.slice(0, 300));

  console.log(failures === 0 ? "\nAll env-validation tests passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}
