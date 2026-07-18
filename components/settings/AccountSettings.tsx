"use client";

/**
 * components/settings/AccountSettings.tsx  (UX-1)
 *
 * Account page — personal information. Moved verbatim from the Profile card of
 * the former SettingsClient.tsx. Email is display-only here; changing it lives
 * under Security. All fields PATCH /api/user/profile via the shared save hook.
 */

import { InlineField, type SelectOption } from "@/components/settings/InlineField";
import { useProfileSave } from "@/components/settings/useProfileSave";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { User } from "lucide-react";
import type { AccountData } from "@/lib/settings/loaders";

const EMPLOYMENT_OPTIONS: SelectOption[] = [
  { value: "EMPLOYED",      label: "Employed" },
  { value: "UNEMPLOYED",    label: "Unemployed" },
  { value: "SELF_EMPLOYED", label: "Self-employed" },
  { value: "STUDENT",       label: "Student" },
  { value: "RETIRED",       label: "Retired" },
];

const USE_CASE_OPTIONS: SelectOption[] = [
  { value: "PERSONAL_TRACKING", label: "Personal budget & net worth tracking" },
  { value: "BUSINESS_VENTURES", label: "Business / LLC financial oversight" },
  { value: "INVESTING",         label: "Portfolio & market focus" },
  { value: "DEBT_MANAGEMENT",   label: "Debt payoff planning" },
  { value: "OTHER",             label: "Other" },
];

const EMPLOYMENT_LABELS = Object.fromEntries(EMPLOYMENT_OPTIONS.map((o) => [o.value, o.label]));
const USE_CASE_LABELS   = Object.fromEntries(USE_CASE_OPTIONS.map((o)   => [o.value, o.label]));

export function AccountSettings({ account }: { account: AccountData }) {
  const saveField = useProfileSave();

  return (
    <SettingsSection icon={User} title="Personal Information">
      <InlineField
        label="Email"
        value={account.email}
        onSave={async () => null}
        readOnly
        helpText="To change your email, go to Security."
      />

      <InlineField
        label="Username"
        value={account.username}
        onSave={(val) => saveField({ username: val })}
        placeholder="e.g. janesmith"
        helpText="3–30 chars · letters, numbers, underscores · used to sign in"
      />

      <InlineField
        label="First name"
        value={account.firstName}
        onSave={(val) => saveField({ firstName: val })}
        placeholder="Jane"
      />

      <InlineField
        label="Last name"
        value={account.lastName}
        onSave={(val) => saveField({ lastName: val })}
        placeholder="Smith"
      />

      <InlineField
        label="Date of birth"
        value=""
        displayValue={account.hasDob ? "On file (encrypted)" : ""}
        onSave={(val) => saveField({ dateOfBirth: val })}
        inputType="date"
        helpText="Stored encrypted · used for age-appropriate financial advice"
      />

      <InlineField
        label="Employment status"
        value={account.employmentStatus}
        displayValue={EMPLOYMENT_LABELS[account.employmentStatus] ?? ""}
        onSave={(val) => saveField({ employmentStatus: val })}
        selectOptions={EMPLOYMENT_OPTIONS}
      />

      <InlineField
        label="Primary use case"
        value={account.useCase}
        displayValue={USE_CASE_LABELS[account.useCase] ?? ""}
        onSave={(val) => saveField({ useCase: val })}
        selectOptions={USE_CASE_OPTIONS}
      />
    </SettingsSection>
  );
}
