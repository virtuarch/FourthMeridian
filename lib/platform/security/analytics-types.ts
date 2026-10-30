/**
 * lib/platform/security/analytics-types.ts  (Platform Spaces 2.0 — Security)
 *
 * The DTO GET /api/platform/security-ops/analytics returns. Client-safe (types
 * only). COUNTS ONLY: no email, identifier, IP, user agent, user id, anomaly key
 * or submitted value ever appears — every figure is aggregated in SQL.
 *
 * Wording contract (owner directive): a failed sign-in or a denied request is
 * NOT an incident. Detector trips are "detector windows", never "attacks".
 * Fourth Meridian stores no lockouts, no verified incidents and no severity —
 * those are declared `unavailable`, never inferred.
 */

export interface SecurityDay {
  day: string;
  signIns: number;
  /** LOGIN_FAILED with a credential-guess reason (lib/security/anomalies CREDENTIAL_GUESS_REASONS). */
  failedCredential: number;
  /** LOGIN_FAILED with a blocked-but-correct reason (unverified, deactivated, pending deletion, disabled admin…). */
  failedBlocked: number;
  /** Platform access-denial records (throttled at write: ≤ 1 per user × area per hour — a floor). */
  accessDenials: number;
  /** Other detector trips (SECURITY_ANOMALY_DETECTED, type ≠ platform_access_denied). */
  detectorTrips: number;
  /** Refused CONTROL changes (PLATFORM_CONTROL_REFUSED). */
  controlRefusals: number;
}

export interface OperatorDay { day: string; success: number; failure: number; refused: number }

export interface Coverage2fa { enrolled: number; total: number }

export interface SecurityAnalyticsResponse {
  checkedAt: string;
  windowDays: 30 | 90;
  from: string;
  to: string;
  days: SecurityDay[];
  /** Failed sign-ins (all reasons) by weekday (Mon = 0) × UTC hour over the window. */
  failedByHour: number[][];
  /** Failed sign-ins by reason code over the window, most first. */
  failureReasons: { reason: string; label: string; kind: "credential" | "blocked"; count: number }[];
  /** Detector trips by detector type over the window (access denials excluded). */
  detectorTypes: { type: string; label: string; count: number }[];
  operators: {
    days: OperatorDay[];
    /** Most frequent operator actions in the window. */
    topActions: { action: string; label: string; count: number }[];
    total: number;
  };
  twoFactor: {
    customers: Coverage2fa;
    operators: Coverage2fa;
    admins: Coverage2fa;
    enforcement: { allUsers: boolean; systemAdmins: boolean; operators: boolean };
  };
  sessions: { active: number };
  /** Signals Fourth Meridian does not record — rendered as "Not recorded", never as zero. */
  unavailable: string[];
  /** True when a grouped read hit its row cap (figures are a floor). */
  floor: boolean;
  notes: string[];
}
