"use client";

/**
 * components/settings/PreferencesSettings.tsx  (UX-1)
 *
 * Preferences page — reporting currency, timezone, and the Default Space picker.
 * All PATCH /api/user/profile via the shared save hook. UI-Convergence Wave 1
 * (W1-E) converged the presentation onto the shared kit — SettingsSection cards,
 * the Atlas Select, and one save signal (Toast success / InlineBanner error) —
 * retiring PreferredSpaceCard's bespoke flash. API + save behavior unchanged.
 */

import { useState } from "react";
import { FX_BASE, SUPPORTED_QUOTES } from "@/lib/fx/config";
import { InlineField, type SelectOption } from "@/components/settings/InlineField";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { useProfileSave } from "@/components/settings/useProfileSave";
import { Select } from "@/components/atlas/fields";
import { InlineBanner } from "@/components/atlas/InlineBanner";
import { useToast } from "@/components/atlas/Toast";
import { displaySpaceName } from "@/lib/format";
import { Loader2, LayoutDashboard, Coins, Globe } from "lucide-react";
import type { PreferencesData, SpaceOption } from "@/lib/settings/loaders";

// Approved reporting currencies (FX_BASE + SUPPORTED_QUOTES; same allowlist the
// API enforces).
const CURRENCY_OPTIONS: SelectOption[] = [FX_BASE, ...SUPPORTED_QUOTES].map((c) => ({ value: c, label: c }));

// OPS-3 S3 — IANA zones from the browser's own Intl (the same authority the
// API validates against); "" clears back to "Not set". The try/catch keeps
// engines without supportedValuesOf from crashing the page (they just get the
// current value only).
function timezoneOptions(current: string | null): SelectOption[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = current ? [current] : [];
  }
  return [
    { value: "", label: "Not set (UTC)" },
    ...zones.map((z) => ({ value: z, label: z.replace(/_/g, " ") })),
  ];
}

// ── Preferred space card ──────────────────────────────────────────────────────

function PreferredSpaceCard({
  spaces,
  initialPreferredId,
  saveField,
}: {
  spaces:             SpaceOption[];
  initialPreferredId: string | null;
  saveField:          (payload: Record<string, string>) => Promise<string | null>;
}) {
  const { toast } = useToast();
  const [preferredId, setPreferredId] = useState(initialPreferredId ?? "");
  const [saving,      setSaving]      = useState(false);
  const [error,       setError]       = useState("");

  const currentName = spaces.find((w) => w.id === preferredId)?.name ?? "";

  async function handleSave(newId: string) {
    setSaving(true);
    setError("");
    const err = await saveField({ preferredSpaceId: newId || "" });
    setSaving(false);
    if (err) {
      setError(err);
    } else {
      setPreferredId(newId);
      toast("Default Space saved");
    }
  }

  const spaceOptions: SelectOption[] = [
    { value: "", label: "Personal Space (default)" },
    ...spaces.filter((w) => w.type !== "PERSONAL").map((w) => ({ value: w.id, label: displaySpaceName(w.name) })),
  ];

  return (
    <SettingsSection
      icon={LayoutDashboard}
      title="Default Space"
      description="The Space that's active by default when you continue in from your Daily Brief. Defaults to your Personal Space if not set."
    >
      {error && <div className="mb-3"><InlineBanner tone="error">{error}</InlineBanner></div>}

      <div className="flex items-center gap-3">
        <Select
          value={preferredId}
          onChange={(e) => handleSave(e.target.value)}
          disabled={saving}
          options={spaceOptions}
          className="flex-1"
        />
        {saving && <Loader2 size={14} className="animate-spin shrink-0" style={{ color: "var(--text-muted)" }} />}
      </div>

      {preferredId && currentName && (
        <p className="text-xs mt-2" style={{ color: "var(--text-faint)" }}>
          Landing on <span style={{ color: "var(--text-secondary)" }}>{currentName}</span> after login.{" "}
          <button
            onClick={() => handleSave("")}
            className="transition-colors"
            style={{ color: "var(--accent-info)" }}
          >
            Reset to default
          </button>
        </p>
      )}
    </SettingsSection>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function PreferencesSettings({ preferences }: { preferences: PreferencesData }) {
  const saveField = useProfileSave();

  return (
    <>
      <SettingsSection icon={Coins} title="Reporting Currency">
        <InlineField
          label="Default reporting currency"
          value={preferences.reportingCurrency}
          displayValue={preferences.reportingCurrency}
          onSave={(val) => saveField({ reportingCurrency: val })}
          selectOptions={CURRENCY_OPTIONS}
          helpText="Default for new Spaces you create. Changing it never affects existing Spaces."
        />
      </SettingsSection>

      {/* OPS-3 S3 — timezone lives HERE (a general preference consumed by
          future digests and Brief greetings), not on the Notifications page. */}
      <SettingsSection icon={Globe} title="Timezone">
        <InlineField
          label="Your timezone"
          value={preferences.timezone ?? ""}
          displayValue={preferences.timezone ? preferences.timezone.replace(/_/g, " ") : "Not set (UTC)"}
          onSave={(val) => saveField({ timezone: val })}
          selectOptions={timezoneOptions(preferences.timezone)}
          helpText="Used for daily summaries and greetings. UTC until set."
        />
      </SettingsSection>

      <PreferredSpaceCard
        spaces={preferences.spaces}
        initialPreferredId={preferences.preferredSpaceId}
        saveField={saveField}
      />
    </>
  );
}
