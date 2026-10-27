"use client";

/**
 * components/platform/widgets/OperatorReasonField.tsx  (SEC-PLAT-2)
 *
 * The structured reason a consequential operator action carries (lib/audit.ts
 * REASON_REQUIRED_ACTIONS): a CODE the operator must choose — never
 * pre-selected (UI-002) — plus an optional ≤280-char note the server scrubs.
 * Controlled: the host owns the value and decides when its confirm is enabled
 * (`reasonPayload(value)` returns null until a code is chosen).
 *
 * The code list mirrors OPERATOR_REASON_CODES; lib/audit.ts is server-only, so a
 * client component cannot import it — lib/platform/operator-action-adoption.test.ts
 * pins this copy equal to the authority.
 */

export const OPERATOR_REASON_FIELD_CODES = ["BETA_ONBOARDING", "SUPPORT_REQUEST", "DOGFOOD", "TESTING", "POLICY_ROLLOUT", "INCIDENT", "ABUSE", "OTHER"] as const;
export type OperatorReasonFieldCode = (typeof OPERATOR_REASON_FIELD_CODES)[number];
const LABEL: Record<OperatorReasonFieldCode, string> = {
  BETA_ONBOARDING: "Beta onboarding", SUPPORT_REQUEST: "Support request", DOGFOOD: "Dogfood", TESTING: "Testing",
  POLICY_ROLLOUT: "Policy rollout", INCIDENT: "Incident", ABUSE: "Abuse", OTHER: "Other",
};

export interface OperatorReasonValue {
  code: OperatorReasonFieldCode | "";
  note: string;
}

export const EMPTY_OPERATOR_REASON: OperatorReasonValue = { code: "", note: "" };

/** The request-body `reason`, or null while no code is chosen. */
export function reasonPayload(v: OperatorReasonValue): { code: OperatorReasonFieldCode; note?: string } | null {
  if (v.code === "") return null;
  const note = v.note.trim();
  return note ? { code: v.code, note } : { code: v.code };
}

export function OperatorReasonField({
  value, onChange, disabled = false, label = "A reason is recorded with this action",
}: {
  value: OperatorReasonValue;
  onChange: (v: OperatorReasonValue) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="mt-3 flex flex-col gap-2 text-left" role="group" aria-label="Reason">
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        <select value={value.code} disabled={disabled} aria-label="Reason"
          onChange={(e) => onChange({ ...value, code: e.target.value as OperatorReasonFieldCode | "" })}
          className="min-h-11 rounded-[var(--radius-sm)] border bg-transparent px-2 py-1 text-base text-[var(--text-primary)] sm:text-xs" style={{ borderColor: "var(--border-hairline)" }}>
          <option value="" disabled>Choose a reason…</option>
          {OPERATOR_REASON_FIELD_CODES.map((c) => <option key={c} value={c}>{LABEL[c]}</option>)}
        </select>
        <input value={value.note} disabled={disabled} maxLength={280} aria-label="Reason note"
          placeholder="Note (optional, no personal data)"
          onChange={(e) => onChange({ ...value, note: e.target.value })}
          className="min-h-11 min-w-[12rem] flex-1 rounded-[var(--radius-sm)] border bg-transparent px-2 py-1 text-base text-[var(--text-primary)] placeholder:text-[var(--text-faint)] sm:text-xs" style={{ borderColor: "var(--border-hairline)" }} />
      </div>
    </div>
  );
}
