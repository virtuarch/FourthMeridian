/**
 * lib/spaces/reporting-currency.ts
 *
 * MC1 Phase 3 Slice 1 — pure reporting-currency helpers for the Space routes.
 * Pure module (no DB, no side effects) in the lib/spaces house style
 * (policy.ts precedent), so the copy-once and allowlist rules are unit-tested
 * without route/DB machinery.
 *
 * Semantics (plan D-1/D-2/D-3, approved):
 *   - Space.reportingCurrency is AUTHORITATIVE; User.reportingCurrency is a
 *     copy-once default for new Spaces. No retroactive inheritance.
 *   - Allowed values = FX_BASE + SUPPORTED_QUOTES (lib/fx/config.ts) —
 *     enforced here at the API boundary, not by a DB constraint.
 *   - Input is normalized to upper case (house precedent: the manual-account
 *     route upcases its currency param).
 */

import { isSupportedCurrency } from "@/lib/fx/config";

export interface ParsedReportingCurrency {
  ok:    true;
  value: string;
}
export interface RejectedReportingCurrency {
  ok:    false;
  error: string;
}

/**
 * Validate + normalize a PATCH `reportingCurrency` input. Rejects anything
 * that is not a string in the approved set (FX_BASE + SUPPORTED_QUOTES);
 * the route maps a rejection to HTTP 400.
 */
export function parseReportingCurrencyInput(
  input: unknown,
): ParsedReportingCurrency | RejectedReportingCurrency {
  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, error: "reportingCurrency must be a non-empty string" };
  }
  const value = input.trim().toUpperCase();
  if (!isSupportedCurrency(value)) {
    return {
      ok: false,
      error: `Unsupported reporting currency "${value}" — must be USD or one of the supported quote currencies`,
    };
  }
  return { ok: true, value };
}

/**
 * Copy-once seed for a new Space (plan D-2): the creator's User default,
 * guarded through the same allowlist (a corrupt/legacy value degrades to
 * "USD" rather than propagating), falling back to "USD" when absent.
 * Called exactly once, at Space creation — never re-applied afterwards.
 */
export function reportingCurrencyForNewSpace(
  creator: { reportingCurrency?: string | null } | null | undefined,
): string {
  const candidate = creator?.reportingCurrency;
  if (typeof candidate === "string" && isSupportedCurrency(candidate.toUpperCase())) {
    return candidate.toUpperCase();
  }
  return "USD";
}
