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
 *   5-10. The V25-FINAL-2 Plaid production-configuration gate.
 *   11-20. V26-ENV-1 deployment-environment classification: Vercel builds
 *      Preview with NODE_ENV=production, so every Vercel case below sets
 *      NODE_ENV=production and varies ONLY VERCEL/VERCEL_ENV. A regression back
 *      to NODE_ENV-based gating makes the Preview cases throw again — which is
 *      exactly the failure that took the whole Preview deployment down (the
 *      instrumentation hook threw, so EVERY route 500'd, not just Plaid).
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
  // OPERATIONALIZATION P0 — the alert destination is production-required.
  PLATFORM_ALERTS_EMAIL:  "ops@example.com",
};

// ── Child mode: import lib/env under the env this process was given ──────────
if (process.argv[2] === "child") {
  (async () => {
    const { validateEnv, getEnvReport } = await import("@/lib/env");
    try {
      validateEnv();
      console.log("VALIDATE_OK");
    } catch (err) {
      console.log(`VALIDATE_THREW: ${(err as Error).message.replace(/\n/g, " | ")}`);
    }
    // OPENAI ENVIRONMENT SEPARATION — the value-free OpenAI facts and the three
    // report rows, one JSON line, so the parent can assert on them.
    const report = getEnvReport();
    console.log(`REPORT_OPENAI ${JSON.stringify({
      openAi: report.openAi,
      rows: report.keys.filter((k) => k.key.startsWith("OPENAI_")),
      ok: report.ok,
    })}`);
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

  console.log("9b. COMMS_RECIPIENT_HASH_SALT (Comms Center A-2a) — warn-only on a deployment, never fatal, value never printed");
  const salted = run({ ...CORE, ...PROD_EXTRA, NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "preview", COMMS_RECIPIENT_HASH_SALT: "s3cret-salt-value" });
  const unsalted = run({ ...CORE, ...PROD_EXTRA, NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "preview" });
  const localUnsalted = run({ ...CORE, NODE_ENV: "test" });
  check("deployed + unset → passes WITH the warning", unsalted.includes("VALIDATE_OK") && unsalted.includes("COMMS_RECIPIENT_HASH_SALT is unset"), unsalted.slice(0, 300));
  check("deployed + set → no warning, and the value is never printed", salted.includes("VALIDATE_OK") && !salted.includes("COMMS_RECIPIENT_HASH_SALT is unset") && !salted.includes("s3cret-salt-value"));
  check("off Vercel (local / CI) → no warning", !localUnsalted.includes("COMMS_RECIPIENT_HASH_SALT is unset"));

  console.log("10. Production + one Plaid cred only (not fully enabled) → not gated on PLAID_ENV");
  // Only CLIENT_ID present ⇒ isPlaidEnabled is false ⇒ ingestion not expected ⇒ the
  // sandbox gate must not fire (it keys on BOTH creds, matching env.isPlaidEnabled).
  const out10 = run({ ...CORE, ...PROD_EXTRA, PLAID_CLIENT_ID: "cid", PLAID_ENV: "sandbox", NODE_ENV: "production" });
  check("VALIDATE_OK", out10.includes("VALIDATE_OK"), out10.slice(0, 300));

  // ── V26-ENV-1 — deployment-environment classification ──────────────────────
  // Vercel builds Preview with NODE_ENV=production. Every case below therefore
  // sets NODE_ENV=production and varies ONLY VERCEL/VERCEL_ENV — if the guards
  // ever regress to keying on NODE_ENV, the Preview cases start throwing again.
  const VERCEL_PROD    = { VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production" };
  const VERCEL_PREVIEW = { VERCEL: "1", VERCEL_ENV: "preview",    NODE_ENV: "production" };
  const VERCEL_DEV     = { VERCEL: "1", VERCEL_ENV: "development", NODE_ENV: "production" };

  console.log("11. Vercel PRODUCTION + Plaid production → passes");
  const out11 = run({ ...CORE, ...PROD_EXTRA, ...PLAID, PLAID_ENV: "production", ...VERCEL_PROD });
  check("VALIDATE_OK", out11.includes("VALIDATE_OK"), out11.slice(0, 300));

  console.log("12. Vercel PRODUCTION + Plaid sandbox → THROWS (guard still armed in prod)");
  const out12 = run({ ...CORE, ...PROD_EXTRA, ...PLAID, PLAID_ENV: "sandbox", ...VERCEL_PROD });
  check("throws", out12.includes("VALIDATE_THREW"), out12.slice(0, 300));
  check("names PLAID_ENV / sandbox", out12.includes("PLAID_ENV") && /sandbox/i.test(out12));

  console.log("13. Vercel PRODUCTION missing prod-only keys → THROWS (PROD_REQUIRED_KEYS enforced)");
  const out13 = run({ ...CORE, ...VERCEL_PROD });
  check("throws", out13.includes("VALIDATE_THREW"), out13.slice(0, 200));
  for (const k of Object.keys(PROD_EXTRA)) check(`names ${k}`, out13.includes(k));

  console.log("14. Vercel PREVIEW + Plaid sandbox → passes (THE regression: preview boot)");
  const out14 = run({ ...CORE, ...PLAID, PLAID_ENV: "sandbox", ...VERCEL_PREVIEW });
  check("VALIDATE_OK", out14.includes("VALIDATE_OK"), out14.slice(0, 300));

  console.log("15. Vercel PREVIEW + production secrets present → still treated as Preview");
  // Carrying prod-only secrets must not promote a Preview deployment to Production:
  // Plaid sandbox stays legal even with the full production key set present.
  const out15 = run({ ...CORE, ...PROD_EXTRA, ...PLAID, PLAID_ENV: "sandbox", ...VERCEL_PREVIEW });
  check("VALIDATE_OK", out15.includes("VALIDATE_OK"), out15.slice(0, 300));

  console.log("16. Vercel PREVIEW without prod-only keys → passes (PROD_REQUIRED_KEYS not enforced)");
  const out16 = run({ ...CORE, ...VERCEL_PREVIEW });
  check("VALIDATE_OK", out16.includes("VALIDATE_OK"), out16.slice(0, 300));
  check("does not demand NEXT_PUBLIC_SENTRY_DSN", !out16.includes("VALIDATE_THREW"));

  console.log("17. Vercel DEVELOPMENT (vercel dev) + Plaid sandbox → passes");
  const out17 = run({ ...CORE, ...PLAID, PLAID_ENV: "sandbox", ...VERCEL_DEV });
  check("VALIDATE_OK", out17.includes("VALIDATE_OK"), out17.slice(0, 300));

  console.log("18. NON-Vercel NODE_ENV=production → production guards remain ACTIVE");
  // No VERCEL var at all ⇒ the original NODE_ENV fallback must be preserved.
  const out18 = run({ ...CORE, ...PROD_EXTRA, ...PLAID, PLAID_ENV: "sandbox", NODE_ENV: "production" });
  check("throws", out18.includes("VALIDATE_THREW"), out18.slice(0, 300));
  check("names PLAID_ENV / sandbox", out18.includes("PLAID_ENV") && /sandbox/i.test(out18));

  console.log("19. NON-Vercel development/test → production guards remain INACTIVE");
  const out19a = run({ ...CORE, ...PLAID, PLAID_ENV: "sandbox", NODE_ENV: "development" });
  check("development VALIDATE_OK", out19a.includes("VALIDATE_OK"), out19a.slice(0, 300));
  const out19b = run({ ...CORE, ...PLAID, PLAID_ENV: "sandbox", NODE_ENV: "test" });
  check("test VALIDATE_OK", out19b.includes("VALIDATE_OK"), out19b.slice(0, 300));

  console.log("20. VERCEL=1 with VERCEL_ENV unset → non-production (documented edge)");
  const out20 = run({ ...CORE, ...PLAID, PLAID_ENV: "sandbox", VERCEL: "1", NODE_ENV: "production" });
  check("VALIDATE_OK", out20.includes("VALIDATE_OK"), out20.slice(0, 300));

  // ── REVIEW-3 — QUANTITY_AUTHORITY_MODE is a declared, validated money switch ─
  console.log("21. QUANTITY_AUTHORITY_MODE=adopt → passes but warns LOUDLY (money switch)");
  const out21 = run({ ...CORE, NODE_ENV: "test", QUANTITY_AUTHORITY_MODE: "adopt" });
  check("VALIDATE_OK (never fatal)", out21.includes("VALIDATE_OK"), out21.slice(0, 300));
  check("warns that money values can change", /QUANTITY_AUTHORITY_MODE/.test(out21) && /money values can change/i.test(out21));

  console.log("22. QUANTITY_AUTHORITY_MODE with a typo → passes, warns treated-as-off");
  const out22 = run({ ...CORE, NODE_ENV: "test", QUANTITY_AUTHORITY_MODE: "adotp" });
  check("VALIDATE_OK (typo never enables/errors)", out22.includes("VALIDATE_OK"), out22.slice(0, 300));
  check("warns unrecognised → off", /unrecognised value/.test(out22) && /treated as "off"/.test(out22));

  console.log("23. QUANTITY_AUTHORITY_MODE unset/off → silent");
  const out23 = run({ ...CORE, NODE_ENV: "test", QUANTITY_AUTHORITY_MODE: "off" });
  check("VALIDATE_OK, no quantity-authority warning", out23.includes("VALIDATE_OK") && !/QUANTITY_AUTHORITY_MODE/.test(out23));

  // ── OPENAI ENVIRONMENT SEPARATION — the value-free OpenAI facts in the report ─
  // Distinctive dummies so "never in the output" is a real assertion. The key is
  // NEVER a real one and the child never calls the provider.
  const DUMMY_KEY = "sk-proj-ENVTEST-DUMMY-NEVER-REAL-0a1b2c3d";
  const DUMMY_PROJECT = "proj_EnvTestDummy77";
  const BAD_PROJECT = "sk-proj-LOOKS-LIKE-A-KEY-IN-THE-WRONG-FIELD";
  type Parsed = { openAi: { keyConfigured: boolean; keyKind: string; projectPin: { state: string; projectId: string | null }; expectedEnvironment: { state: string; expected: string | null; actual: string }; refused: boolean }; rows: { key: string; status: string; note?: string }[]; ok: boolean };
  const parse = (out: string): Parsed | null => { const m = out.match(/^REPORT_OPENAI (.*)$/m); return m ? JSON.parse(m[1]) as Parsed : null; };
  const row = (p: Parsed, key: string) => p.rows.find((r) => r.key === key);

  console.log("24. OpenAI unconfigured → warn rows, report still ok, facts say so");
  const out24 = run({ ...CORE, NODE_ENV: "test" });
  const p24 = parse(out24);
  check("report line present", p24 !== null, out24.slice(0, 200));
  check("key not configured, unknown shape", !!p24 && !p24.openAi.keyConfigured && p24.openAi.keyKind === "unknown");
  check("OPENAI_API_KEY row warn (AI disabled)", row(p24!, "OPENAI_API_KEY")?.status === "warn");
  check("OPENAI_PROJECT_ID row warn (unpinned)", row(p24!, "OPENAI_PROJECT_ID")?.status === "warn" && p24!.openAi.projectPin.state === "unpinned");
  check("OPENAI_EXPECTED_ENVIRONMENT row warn (unset)", row(p24!, "OPENAI_EXPECTED_ENVIRONMENT")?.status === "warn" && p24!.openAi.expectedEnvironment.state === "unset");
  check("not refused; report ok", !!p24 && !p24.openAi.refused && p24.ok);

  console.log("25. Vercel PREVIEW, project key + pin + guard=preview → all pass, pin shown in full, key never shown");
  const out25 = run({ ...CORE, ...VERCEL_PREVIEW, OPENAI_API_KEY: DUMMY_KEY, OPENAI_PROJECT_ID: DUMMY_PROJECT, OPENAI_EXPECTED_ENVIRONMENT: "preview" });
  const p25 = parse(out25);
  check("VALIDATE_OK", out25.includes("VALIDATE_OK"), out25.slice(0, 200));
  check("three OPENAI rows pass", !!p25 && ["OPENAI_API_KEY", "OPENAI_PROJECT_ID", "OPENAI_EXPECTED_ENVIRONMENT"].every((k) => row(p25, k)?.status === "pass"));
  check("project key shape", p25?.openAi.keyKind === "project");
  check("pinned, id in full", p25?.openAi.projectPin.state === "pinned" && p25?.openAi.projectPin.projectId === DUMMY_PROJECT && (row(p25!, "OPENAI_PROJECT_ID")?.note ?? "").includes(DUMMY_PROJECT));
  check("guard match · preview (actual preview)", p25?.openAi.expectedEnvironment.state === "match" && p25?.openAi.expectedEnvironment.actual === "preview");
  check("THE KEY NEVER APPEARS in the child's output", !out25.includes(DUMMY_KEY));

  console.log("26. Vercel PRODUCTION with a PREVIEW record (guard=preview) → fail row, loud warning, NO boot throw");
  const out26 = run({ ...CORE, ...PROD_EXTRA, ...VERCEL_PROD, OPENAI_API_KEY: DUMMY_KEY, OPENAI_PROJECT_ID: DUMMY_PROJECT, OPENAI_EXPECTED_ENVIRONMENT: "preview" });
  const p26 = parse(out26);
  check("VALIDATE_OK (an AI misconfiguration never takes the deployment down)", out26.includes("VALIDATE_OK"), out26.slice(0, 300));
  check("loud warning names both environments", /OPENAI_EXPECTED_ENVIRONMENT says "preview" but this is a "production" deployment/.test(out26));
  check("OPENAI_EXPECTED_ENVIRONMENT row fail", row(p26!, "OPENAI_EXPECTED_ENVIRONMENT")?.status === "fail");
  check("facts: mismatch, refused, report not ok", p26?.openAi.expectedEnvironment.state === "mismatch" && p26?.openAi.refused === true && p26?.ok === false);
  check("key never appears", !out26.includes(DUMMY_KEY));

  console.log("27. malformed OPENAI_PROJECT_ID → fail row, warning, value NEVER shown");
  const out27 = run({ ...CORE, NODE_ENV: "test", OPENAI_API_KEY: DUMMY_KEY, OPENAI_PROJECT_ID: BAD_PROJECT });
  const p27 = parse(out27);
  check("VALIDATE_OK (no throw)", out27.includes("VALIDATE_OK"), out27.slice(0, 300));
  check("warns about the pin", /OPENAI_PROJECT_ID is set but is not an OpenAI project id/.test(out27));
  check("OPENAI_PROJECT_ID row fail; projectId null", row(p27!, "OPENAI_PROJECT_ID")?.status === "fail" && p27?.openAi.projectPin.state === "misconfigured" && p27?.openAi.projectPin.projectId === null);
  check("the malformed value and the key never appear", !out27.includes(BAD_PROJECT) && !out27.includes(DUMMY_KEY));

  console.log("28. unrecognised OPENAI_EXPECTED_ENVIRONMENT → fail row, warning, value never shown");
  const out28 = run({ ...CORE, NODE_ENV: "test", OPENAI_API_KEY: DUMMY_KEY, OPENAI_EXPECTED_ENVIRONMENT: "prodcution" });
  const p28 = parse(out28);
  check("VALIDATE_OK (no throw)", out28.includes("VALIDATE_OK"), out28.slice(0, 300));
  check("warns, names the variable", /OPENAI_EXPECTED_ENVIRONMENT has an unrecognised value/.test(out28));
  check("row fail; expected null", row(p28!, "OPENAI_EXPECTED_ENVIRONMENT")?.status === "fail" && p28?.openAi.expectedEnvironment.state === "invalid" && p28?.openAi.expectedEnvironment.expected === null);
  check("value never appears", !out28.includes("prodcution"));

  console.log("29. legacy user key, unpinned → pass row with the legacy note, warn pin");
  const out29 = run({ ...CORE, NODE_ENV: "test", OPENAI_API_KEY: "sk-LEGACYDUMMYNEVERREAL" });
  const p29 = parse(out29);
  check("legacy shape", p29?.openAi.keyKind === "legacy");
  check("key row pass with legacy note", row(p29!, "OPENAI_API_KEY")?.status === "pass" && /legacy/.test(row(p29!, "OPENAI_API_KEY")?.note ?? ""));
  check("key never appears", !out29.includes("sk-LEGACYDUMMYNEVERREAL"));

  console.log("30. service-account key (the intended kind) → pass row 'service-account key (project-scoped)', never 'legacy'");
  const SVC_KEY = "sk-svcacct-ENVTEST-DUMMY-NEVER-REAL-4d5e6f";
  const out30 = run({ ...CORE, ...VERCEL_PREVIEW, OPENAI_API_KEY: SVC_KEY, OPENAI_PROJECT_ID: DUMMY_PROJECT, OPENAI_EXPECTED_ENVIRONMENT: "preview" });
  const p30 = parse(out30);
  check("service-account shape", p30?.openAi.keyKind === "service-account");
  const note30 = row(p30!, "OPENAI_API_KEY")?.note ?? "";
  check("key row pass, project-scoped note, no 'legacy'", row(p30!, "OPENAI_API_KEY")?.status === "pass" && /service-account key \(project-scoped\)/.test(note30) && !/legacy/.test(note30));
  check("pin and guard pass alongside", row(p30!, "OPENAI_PROJECT_ID")?.status === "pass" && row(p30!, "OPENAI_EXPECTED_ENVIRONMENT")?.status === "pass");
  check("key never appears", !out30.includes(SVC_KEY));

  console.log(failures === 0 ? "\nAll env-validation tests passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}
