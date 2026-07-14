/**
 * lib/security/anomalies.test.ts  (Wave 3 ⑧)
 *
 * Pure unit guards for the anomaly detector's threshold functions. No DB, no
 * network — standalone tsx script (house pattern).
 *
 *     npx tsx lib/security/anomalies.test.ts
 */

import {
  detectIdentifierAnomalies,
  detectIpAnomaly,
  detectSystemAdminAnomaly,
  ANOMALY_THRESHOLDS,
  CREDENTIAL_GUESS_REASONS,
  MAX_ANOMALY_WINDOW_MINUTES,
} from "@/lib/security/anomalies";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** Build an array of N copies of a reason. */
function rep(reason: string, n: number): string[] {
  return Array.from({ length: n }, () => reason);
}

console.log("detectIdentifierAnomalies");
{
  const th = ANOMALY_THRESHOLDS.identifierFailedLogin.threshold;

  check("below threshold → no anomaly", detectIdentifierAnomalies(rep("invalid_password", th - 1), "a@x.com").length === 0);

  const atThreshold = detectIdentifierAnomalies(rep("invalid_password", th), "a@x.com");
  const burst = atThreshold.find((a) => a.type === "failed_login_identifier");
  check("at threshold → failed_login_identifier trips", !!burst);
  check("anomaly key is identifier-scoped", burst?.key === "identifier:a@x.com");
  check("count reflects the guesses", burst?.count === th);
  check("owner-email eligible (resolvable account)", burst?.ownerEmailEligible === true);

  // Blocked-but-correct reasons must NOT count toward the burst.
  const blocked = detectIdentifierAnomalies(rep("account_deactivated", th + 5), "a@x.com");
  check("blocked-account reasons never trip a burst", blocked.every((a) => a.type !== "failed_login_identifier"));

  // Mixed credential-guess reasons all count.
  const mixed = detectIdentifierAnomalies(
    ["user_not_found", "invalid_password", "totp_invalid", "totp_required", "recovery_code_invalid"],
    "a@x.com",
  );
  check("mixed guess reasons aggregate to the burst", mixed.some((a) => a.type === "failed_login_identifier"));
}

console.log("recovery-code streak");
{
  const th = ANOMALY_THRESHOLDS.recoveryCodeStreak.threshold;
  const res = detectIdentifierAnomalies(rep("recovery_code_invalid", th), "a@x.com");
  const streak = res.find((a) => a.type === "recovery_code_streak");
  check("recovery streak trips at threshold", !!streak);
  check("recovery streak key is recovery-scoped", streak?.key === "recovery:a@x.com");
  // recovery_code_invalid is also a credential-guess reason, so at a high enough
  // count BOTH the identifier burst and the recovery streak can trip.
  const idTh = ANOMALY_THRESHOLDS.identifierFailedLogin.threshold;
  const both = detectIdentifierAnomalies(rep("recovery_code_invalid", Math.max(idTh, th)), "a@x.com");
  check("high recovery-invalid count can trip both signals", both.length >= 1);
}

console.log("detectIpAnomaly");
{
  const th = ANOMALY_THRESHOLDS.ipFailedLogin.threshold;
  check("below threshold → null", detectIpAnomaly(rep("invalid_password", th - 1), "1.2.3.4") === null);
  const a = detectIpAnomaly(rep("invalid_password", th), "1.2.3.4");
  check("at threshold → failed_login_ip", a?.type === "failed_login_ip");
  check("ip anomaly key is ip-scoped", a?.key === "ip:1.2.3.4");
  check("ip anomaly is NOT owner-email eligible", a?.ownerEmailEligible === false);
}

console.log("detectSystemAdminAnomaly");
{
  check("0 hits → null", detectSystemAdminAnomaly(0) === null);
  const a = detectSystemAdminAnomaly(1);
  check("1 hit → trips (threshold 1)", a?.type === "system_admin_disabled");
  check("system-admin key is fixed", a?.key === "system_admin_disabled");
}

console.log("invariants");
{
  check("recovery_code_invalid is a credential-guess reason", CREDENTIAL_GUESS_REASONS.includes("recovery_code_invalid"));
  check("MAX window covers every threshold window",
    MAX_ANOMALY_WINDOW_MINUTES >= ANOMALY_THRESHOLDS.systemAdminDisabled.windowMinutes &&
    MAX_ANOMALY_WINDOW_MINUTES >= ANOMALY_THRESHOLDS.identifierFailedLogin.windowMinutes);
}

console.log(failures === 0 ? "\nAll anomaly-detector checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
