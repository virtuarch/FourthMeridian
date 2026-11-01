/**
 * lib/email/security-alerts.ts
 *
 * The copy of every security-alert email, in one place. Each builder returns
 * the SecurityAlertData a call site passes to sendEmail("security-alert", …),
 * and lib/email/preview.ts renders the SAME builders, so a preview is exactly
 * the email that ships.
 *
 * Rules for this copy:
 *   - factual: say what happened and when; never claim an incident occurred;
 *   - every absolute time in UTC WITH the zone label (formatUtcDateTimeLabelled);
 *   - no financial data, balances, account numbers or exported content;
 *   - links only from the trusted app base (buildAppLink / NEXT_PUBLIC_APP_URL).
 *
 * Pure: no env, no DB. Callers pass `now` / the trusted base.
 */

import { formatUtcDateTimeLabelled } from "@/lib/email/design/datetime";
import { APP_PATHS, buildAppLink } from "@/lib/email/app-link";
import type { SecurityAlertData } from "@/lib/email/templates/security-alert";

/** reset-password: the reset completed (sent after the token is consumed). */
export function passwordResetCompletedAlert(at: Date): SecurityAlertData {
  return {
    title:   "Your password was reset",
    message: `Your Fourth Meridian password was reset on ${formatUtcDateTimeLabelled(at)}.`,
  };
}

/** user/password: an authenticated password change. */
export function passwordChangedAlert(at: Date): SecurityAlertData {
  return {
    title:   "Your password was changed",
    message: `Your Fourth Meridian password was changed on ${formatUtcDateTimeLabelled(at)}.`,
  };
}

/** user/export: a data export ran. The email never carries any exported data. */
export function dataExportedAlert(at: Date, appBaseUrl: string): SecurityAlertData {
  return {
    title:    "Your data was exported",
    message:
      `A copy of your Fourth Meridian data was exported on ${formatUtcDateTimeLabelled(at)}.\n\n` +
      `This email does not contain any of the exported data.`,
    guidance:
      "If this was you, no action is needed. If you don't recognize this activity, change your " +
      "password and review your active sessions.",
    action:   { label: "Review account security", url: buildAppLink(appBaseUrl, APP_PATHS.accountSecurity) },
  };
}

/** user/email/request: warn the OLD address before any swap. */
export function emailChangeRequestedAlert(newEmail: string, at: Date): SecurityAlertData {
  return {
    title:   "Email change requested",
    message:
      `A change of your Fourth Meridian account email to ${newEmail} was requested on ` +
      `${formatUtcDateTimeLabelled(at)}. The change is not complete until confirmed from the new address.`,
  };
}

/** admin 2FA reset: an administrator removed the factor. */
export function twoFactorResetAlert(at: Date): SecurityAlertData {
  return {
    title:    "Two-factor authentication was reset on your account",
    message:
      `An administrator reset two-factor authentication on your Fourth Meridian account on ` +
      `${formatUtcDateTimeLabelled(at)}. You have been signed out everywhere and will be asked to set up ` +
      `two-factor authentication again at your next sign-in.`,
    guidance: "If you did not expect this, contact support immediately.",
  };
}

/** user/deactivate. */
export function accountDeactivatedAlert(at: Date): SecurityAlertData {
  return {
    title:   "Your account was deactivated",
    message:
      `Your Fourth Meridian account was deactivated on ${formatUtcDateTimeLabelled(at)}. ` +
      `Your data is kept — sign in again anytime to reactivate your account.`,
  };
}

/** auth: sign-in reactivated a deactivated account. */
export function accountReactivatedAlert(at: Date): SecurityAlertData {
  return {
    title:   "Your account was reactivated",
    message: `Your Fourth Meridian account was reactivated on ${formatUtcDateTimeLabelled(at)}.`,
  };
}

/** user/delete: deletion scheduled at the end of the grace period. */
export function accountDeletionScheduledAlert(scheduledAt: Date): SecurityAlertData {
  return {
    title:    "Your account is scheduled for deletion",
    message:
      `Your Fourth Meridian account is scheduled for deletion on ${formatUtcDateTimeLabelled(scheduledAt)}. ` +
      `You can cancel any time before then by signing back in and choosing "Cancel deletion".`,
    guidance: "If this wasn't you, sign in now to cancel.",
  };
}

/** auth: sign-in cancelled a scheduled deletion. */
export function accountDeletionCancelledAlert(at: Date): SecurityAlertData {
  return {
    title:   "Your account deletion was cancelled",
    message: `Your scheduled Fourth Meridian account deletion was cancelled on ${formatUtcDateTimeLabelled(at)}. Your account is active again.`,
  };
}

/** account-deletion purge: the final notice, after commit. */
export function accountDeletedAlert(): SecurityAlertData {
  return {
    title:    "Your account has been deleted",
    message:
      `Your Fourth Meridian account and all associated data have been permanently deleted. ` +
      `This action cannot be undone.`,
    guidance: "If you did not expect this, contact support.",
  };
}

/** anomaly lockout hybrid: owner of a resolvable account with a failed-sign-in burst. No token. */
export function ownerSignInAnomalyAlert(appBaseUrl: string): SecurityAlertData {
  return {
    title:    "Unusual sign-in activity on your account",
    message:
      `We noticed several failed sign-in attempts on your Fourth Meridian account. ` +
      `If this was you, no action is needed.`,
    guidance: "If it wasn't you, reset your password to secure your account.",
    action:   { label: "Reset your password", url: buildAppLink(appBaseUrl, "/forgot-password") },
  };
}

/** The anomaly fields the Security Ops email reads (lib/security/anomalies.ts DetectedAnomaly). */
export interface SecurityOpsAnomaly {
  key: string;
  title: string;
  message: string;
  count: number;
  windowMinutes: number;
  threshold: number;
}

/**
 * The signal KIND of an anomaly key ("identifier:<raw>" → "identifier",
 * "ip:<addr>" → "ip", "system_admin_disabled" → itself). The raw login
 * identifier / IP is deliberately NOT emailed: it stays on the
 * SECURITY_ANOMALY_DETECTED audit row (metadata.key) only. The Security Ops
 * in-app notification carries a salted hash of it (anomalyKey, equal to the
 * audit row's metadata.keyHash — Comms Center A-2b, O-8).
 */
export function anomalySignalKind(key: string): string {
  const i = key.indexOf(":");
  return i === -1 ? key : key.slice(0, i);
}

/** anomaly fan-out (b): the Security Operations inbox (internal variant). */
export function securityOpsAnomalyAlert(anomaly: SecurityOpsAnomaly): SecurityAlertData {
  return {
    audience: "internal",
    title:    anomaly.title,
    message:
      `${anomaly.message}\n\n` +
      `Signal: ${anomalySignalKind(anomaly.key)} — ${anomaly.count} in the last ${anomaly.windowMinutes} minutes ` +
      `(threshold ${anomaly.threshold}). The identifier is withheld from email; see Security Ops for details.`,
  };
}

/** Display copy for a Platform access change (resolved by the caller from lib/platform/policy.ts). */
export interface PlatformAccessChange {
  /** PlatformArea enum value, e.g. "SECURITY_OPS" (path segment of the area's page). */
  area: string;
  /** The area's display name, e.g. "Security Operations". */
  areaLabel: string;
  /** The access level's display phrase, e.g. "read-only". */
  levelLabel: string;
}

/**
 * admin platform-grants: access to a Platform area was granted, reinstated or
 * changed. Names the grantor by ROLE only — every grant mutation is
 * SYSTEM_ADMIN-only — never by name or address.
 */
export function platformAccessGrantedAlert(
  change: PlatformAccessChange & { kind: "granted" | "reinstated" | "level_changed" },
  at: Date,
  appBaseUrl: string,
): SecurityAlertData {
  const verb = change.kind === "level_changed" ? "changed your access to" : "gave you access to";
  return {
    title:    change.kind === "level_changed" ? `Your ${change.areaLabel} access changed` : `You were given access to ${change.areaLabel}`,
    message:
      `A Fourth Meridian system administrator ${verb} ${change.areaLabel} on ${formatUtcDateTimeLabelled(at)}. ` +
      `Your access level is now ${change.levelLabel}.`,
    guidance: "If you weren't expecting this change, contact support.",
    action:   { label: `Open ${change.areaLabel}`, url: buildAppLink(appBaseUrl, `/dashboard/platform/${change.area}`) },
  };
}

/** admin platform-grants/[grantId]: access to a Platform area was removed. No link: the area is closed to them now. */
export function platformAccessRemovedAlert(change: PlatformAccessChange, at: Date): SecurityAlertData {
  return {
    title:    `Your access to ${change.areaLabel} was removed`,
    message:
      `A Fourth Meridian system administrator removed your ${change.levelLabel} access to ${change.areaLabel} on ` +
      `${formatUtcDateTimeLabelled(at)}.`,
    guidance: "If you weren't expecting this change, contact support.",
  };
}
