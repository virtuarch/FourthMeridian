"use client";

/**
 * components/settings/PreferencesSettings.tsx  (UX-1)
 *
 * Preferences page — user preference values. Moves the reporting-currency
 * field and the Default Space picker out of the former SettingsClient.tsx.
 * Both PATCH /api/user/profile via the shared save hook; behavior unchanged.
 */

import { useState } from "react";
import { FX_BASE, SUPPORTED_QUOTES } from "@/lib/fx/config";
import { InlineField, INPUT_BASE, inputStyle, type SelectOption } from "@/components/settings/InlineField";
import { useProfileSave } from "@/components/settings/useProfileSave";
import { DataCard, DataCardTitle } from "@/components/atlas/DataCard";
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

// ── Preferred space card (moved verbatim from SettingsClient) ─────────────────

function PreferredSpaceCard({
  spaces,
  initialPreferredId,
  saveField,
}: {
  spaces:             SpaceOption[];
  initialPreferredId: string | null;
  saveField:          (payload: Record<string, string>) => Promise<string | null>;
}) {
  const [preferredId, setPreferredId] = useState(initialPreferredId ?? "");
  const [saving,      setSaving]      = useState(false);
  const [error,       setError]       = useState("");
  const [flash,       setFlash]       = useState(false);

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
      setFlash(true);
      setTimeout(() => setFlash(false), 2500);
    }
  }

  const selectCls = INPUT_BASE + " px-3 py-2 appearance-none";

  return (
    <DataCard>
      <div className="flex items-center gap-2 mb-1">
        <LayoutDashboard size={15} style={{ color: "var(--text-secondary)" }} />
        <DataCardTitle>Default Space</DataCardTitle>
      </div>
      <p className="text-xs mb-4" style={{ color: "var(--text-faint)" }}>
        The Space that&apos;s active by default when you continue in from your Daily Brief. Defaults to your Personal Space if not set.
      </p>

      {error && (
        <div className="rounded-xl border px-3 py-2 text-sm mb-3" style={{ background: "rgba(237,82,71,0.10)", borderColor: "rgba(237,82,71,0.30)", color: "var(--accent-negative)" }}>
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <select
          value={preferredId}
          onChange={(e) => handleSave(e.target.value)}
          disabled={saving}
          className={selectCls + " flex-1"}
          style={inputStyle}
        >
          <option value="">Personal Space (default)</option>
          {spaces.filter((w) => w.type !== "PERSONAL").map((w) => (
            <option key={w.id} value={w.id}>{displaySpaceName(w.name)}</option>
          ))}
        </select>
        {saving && <Loader2 size={14} className="animate-spin shrink-0" style={{ color: "var(--text-muted)" }} />}
        {flash   && <span className="text-xs shrink-0" style={{ color: "var(--accent-positive)" }}>Saved ✓</span>}
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
    </DataCard>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function PreferencesSettings({ preferences }: { preferences: PreferencesData }) {
  const saveField = useProfileSave();

  return (
    <>
      <DataCard>
        <div className="flex items-center gap-2 mb-1">
          <Coins size={15} style={{ color: "var(--text-secondary)" }} />
          <DataCardTitle>Reporting Currency</DataCardTitle>
        </div>

        <InlineField
          label="Default reporting currency"
          value={preferences.reportingCurrency}
          displayValue={preferences.reportingCurrency}
          onSave={(val) => saveField({ reportingCurrency: val })}
          selectOptions={CURRENCY_OPTIONS}
          helpText="Default for new Spaces you create. Changing it never affects existing Spaces."
        />
      </DataCard>

      {/* OPS-3 S3 — timezone lives HERE (a general preference consumed by
          future digests and Brief greetings), not on the Notifications page. */}
      <DataCard>
        <div className="flex items-center gap-2 mb-1">
          <Globe size={15} style={{ color: "var(--text-secondary)" }} />
          <DataCardTitle>Timezone</DataCardTitle>
        </div>

        <InlineField
          label="Your timezone"
          value={preferences.timezone ?? ""}
          displayValue={preferences.timezone ? preferences.timezone.replace(/_/g, " ") : "Not set (UTC)"}
          onSave={(val) => saveField({ timezone: val })}
          selectOptions={timezoneOptions(preferences.timezone)}
          helpText="Used for daily summaries and greetings. UTC until set."
        />
      </DataCard>

      <PreferredSpaceCard
        spaces={preferences.spaces}
        initialPreferredId={preferences.preferredSpaceId}
        saveField={saveField}
      />
    </>
  );
}
