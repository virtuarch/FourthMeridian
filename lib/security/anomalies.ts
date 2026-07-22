/**
 * lib/security/anomalies.ts  (Wave 3 ⑧ — Security Ops anomaly detector, PURE core)
 *
 * Pure threshold functions over recent `LOGIN_FAILED` audit activity. No DB, no
 * I/O, no side effects — the impure side (fetching the window's rows, dedupe,
 * fan-out) lives in lib/security/anomaly-alerts.ts, which calls these.
 *
 * The detector is invoked INLINE at the producer (after the LOGIN_FAILED audit
 * writes in lib/auth.ts's authorize()), not by a polling job: it's a cheap
 * bounded count that only runs when a failure just happened, so it's real-time
 * by construction with no scheduler dependency (investigation §6.6).
 *
 * SIGNALS (v1):
 *   - failed-login burst per identifier   → the owner-email hybrid trips here
 *   - failed-login burst per IP            → credential stuffing from one source
 *   - recovery-code-invalid streak         → 2FA-recovery guessing on one account
 *   - disabled-admin probe                 → anyone hitting the DISABLE_SYSTEM_ADMIN god account
 *
 * "failed login" for burst counting means the CREDENTIAL-GUESS reasons only
 * (below) — NOT the blocked-but-correct-password reasons (email_unverified,
 * pending_deletion, account_deactivated), which are legitimate users hitting a
 * gate, not attackers guessing.
 *
 * (Flapping-connection signals from Wave 1⑤'s transition history were considered
 * — see the prompt's optional note — and deliberately NOT included in v1: they
 * are a connection-health concern already surfaced by CH-1's widget, not an
 * authentication anomaly, and folding them in here would blur this detector's
 * single responsibility. Recorded as a conscious exclusion, not an oversight.)
 */

/** Reasons that represent an attacker/forgetful-user GUESS (vs a blocked login). */
export const CREDENTIAL_GUESS_REASONS: readonly string[] = [
  "user_not_found",
  "invalid_password",
  "totp_required",
  "totp_invalid",
  "recovery_code_invalid",
];

/** Reason written by authorize() when the disabled SYSTEM_ADMIN account is hit. */
export const SYSTEM_ADMIN_DISABLED_REASON = "system_admin_disabled";

/**
 * Thresholds + windows. Chosen to sit ABOVE ordinary fat-finger noise and the
 * CAPTCHA step-up (3), and — for the per-identifier burst — to fire the owner
 * heads-up email BEFORE the hard per-identifier rate-limit ceiling (10 / 15 min)
 * would start silently dropping attempts.
 */
export const ANOMALY_THRESHOLDS = {
  /** ≥ N credential-guess failures on ONE identifier within the window. */
  identifierFailedLogin: { threshold: 5, windowMinutes: 15 },
  /** ≥ N credential-guess failures from ONE IP within the window (stuffing). */
  ipFailedLogin:         { threshold: 10, windowMinutes: 15 },
  /** ≥ N invalid recovery codes on ONE identifier within the window. */
  recoveryCodeStreak:    { threshold: 3, windowMinutes: 15 },
  /** Any hit on the disabled SYSTEM_ADMIN account within the window. */
  systemAdminDisabled:   { threshold: 1, windowMinutes: 60 },
} as const;

export type AnomalyType =
  | "failed_login_identifier"
  | "failed_login_ip"
  | "recovery_code_streak"
  | "system_admin_disabled";

export interface DetectedAnomaly {
  type: AnomalyType;
  /** Stable dedupe identity for this open window (goes into metadata.key). */
  key: string;
  count: number;
  threshold: number;
  windowMinutes: number;
  /** Short headline (email subject + notification title). */
  title: string;
  /** Body detail (email message + notification summary). Non-alarming, factual. */
  message: string;
  /** True when this anomaly is a failed-login burst tied to a resolvable
   *  account — the ONLY case that also emails the account owner (§6.5 hybrid). */
  ownerEmailEligible: boolean;
}

/** Count reasons in a set. */
function countReasons(reasons: readonly string[], allowed: readonly string[]): number {
  const set = new Set(allowed);
  let n = 0;
  for (const r of reasons) if (set.has(r)) n++;
  return n;
}

/**
 * Per-identifier anomalies from that identifier's recent LOGIN_FAILED reasons.
 * Returns the failed-login burst and/or the recovery-code streak if tripped.
 */
export function detectIdentifierAnomalies(
  reasons: readonly string[],
  identifier: string,
): DetectedAnomaly[] {
  const out: DetectedAnomaly[] = [];

  const guessCount = countReasons(reasons, CREDENTIAL_GUESS_REASONS);
  const idCfg = ANOMALY_THRESHOLDS.identifierFailedLogin;
  if (guessCount >= idCfg.threshold) {
    out.push({
      type: "failed_login_identifier",
      key: `identifier:${identifier}`,
      count: guessCount,
      threshold: idCfg.threshold,
      windowMinutes: idCfg.windowMinutes,
      title: "Repeated failed sign-in attempts",
      message:
        `We noticed ${guessCount} failed sign-in attempts on this account in the ` +
        `last ${idCfg.windowMinutes} minutes.`,
      ownerEmailEligible: true,
    });
  }

  const recoveryCount = countReasons(reasons, ["recovery_code_invalid"]);
  const rcCfg = ANOMALY_THRESHOLDS.recoveryCodeStreak;
  if (recoveryCount >= rcCfg.threshold) {
    out.push({
      type: "recovery_code_streak",
      key: `recovery:${identifier}`,
      count: recoveryCount,
      threshold: rcCfg.threshold,
      windowMinutes: rcCfg.windowMinutes,
      title: "Repeated invalid recovery codes",
      message:
        `We noticed ${recoveryCount} invalid two-factor recovery codes on this ` +
        `account in the last ${rcCfg.windowMinutes} minutes.`,
      ownerEmailEligible: true,
    });
  }

  return out;
}

/** Per-IP failed-login burst from that IP's recent LOGIN_FAILED reasons. */
export function detectIpAnomaly(
  reasons: readonly string[],
  ip: string,
): DetectedAnomaly | null {
  const guessCount = countReasons(reasons, CREDENTIAL_GUESS_REASONS);
  const cfg = ANOMALY_THRESHOLDS.ipFailedLogin;
  if (guessCount < cfg.threshold) return null;
  return {
    type: "failed_login_ip",
    key: `ip:${ip}`,
    count: guessCount,
    threshold: cfg.threshold,
    windowMinutes: cfg.windowMinutes,
    title: "Failed sign-in burst from one source",
    message:
      `We saw ${guessCount} failed sign-in attempts from a single IP address in ` +
      `the last ${cfg.windowMinutes} minutes.`,
    ownerEmailEligible: false, // spans many identifiers — no single owner
  };
}

/** Disabled-admin probe: any hit within the window trips. */
export function detectSystemAdminAnomaly(count: number): DetectedAnomaly | null {
  const cfg = ANOMALY_THRESHOLDS.systemAdminDisabled;
  if (count < cfg.threshold) return null;
  return {
    type: "system_admin_disabled",
    key: "system_admin_disabled",
    count,
    threshold: cfg.threshold,
    windowMinutes: cfg.windowMinutes,
    title: "Disabled admin account probed",
    message:
      `The disabled SYSTEM_ADMIN account received ${count} sign-in attempt(s) in ` +
      `the last ${cfg.windowMinutes} minutes.`,
    ownerEmailEligible: false,
  };
}

/** The widest window any signal uses — the fetch horizon for the orchestrator. */
export const MAX_ANOMALY_WINDOW_MINUTES = Math.max(
  ANOMALY_THRESHOLDS.identifierFailedLogin.windowMinutes,
  ANOMALY_THRESHOLDS.ipFailedLogin.windowMinutes,
  ANOMALY_THRESHOLDS.recoveryCodeStreak.windowMinutes,
  ANOMALY_THRESHOLDS.systemAdminDisabled.windowMinutes,
);
