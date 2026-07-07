"use client";

/**
 * components/settings/InlineField.tsx
 *
 * Shared inline-editable field primitive for the Settings section (UX-1).
 * Extracted verbatim from the former components/dashboard/SettingsClient.tsx
 * so Account and Preferences pages can both reuse it without duplication.
 * Behavior is unchanged — same save/flash/error/keyboard handling.
 */

import { useState } from "react";
import { Pencil, Check, X, Loader2 } from "lucide-react";

export interface SelectOption { value: string; label: string; }

// ── Shared input styling (Atlas tokens) ──────────────────────────────────────
export const INPUT_BASE =
  "w-full border rounded-lg text-sm focus:outline-none focus:border-[var(--accent-info)] transition-colors placeholder:text-[var(--text-faint)]";
export const inputStyle: React.CSSProperties = {
  background:  "var(--surface-inset)",
  borderColor: "var(--border-hairline)",
  color:       "var(--text-primary)",
};

export function InlineField({
  label,
  value,
  displayValue,
  onSave,
  inputType   = "text",
  placeholder = "",
  helpText,
  selectOptions,
  readOnly,
}: {
  label:          string;
  value:          string;
  displayValue?:  string;
  onSave:         (val: string) => Promise<string | null>;
  inputType?:     string;
  placeholder?:   string;
  helpText?:      string;
  selectOptions?: SelectOption[];
  readOnly?:      boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(value);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState("");
  const [current, setCurrent] = useState(value);
  const [curDisp, setCurDisp] = useState(displayValue ?? value);
  const [flash,   setFlash]   = useState(false);

  async function handleSave() {
    if (draft === current) { setEditing(false); return; }
    setSaving(true);
    setError("");
    const err = await onSave(draft);
    setSaving(false);
    if (err) {
      setError(err);
    } else {
      setCurrent(draft);
      const newDisplay = selectOptions
        ? selectOptions.find((o) => o.value === draft)?.label ?? draft
        : draft;
      setCurDisp(newDisplay);
      setEditing(false);
      setFlash(true);
      setTimeout(() => setFlash(false), 2500);
    }
  }

  function handleCancel() { setDraft(current); setError(""); setEditing(false); }

  const inputCls = INPUT_BASE + " px-3 py-2";

  return (
    <div className="flex items-start justify-between gap-4 py-3.5 border-b last:border-0" style={{ borderColor: "var(--border-hairline)" }}>
      <div className="flex-1 min-w-0">
        <p className="text-xs mb-0.5" style={{ color: "var(--text-muted)" }}>{label}</p>

        {editing ? (
          <div className="mt-1.5 space-y-2">
            {selectOptions ? (
              <select
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoFocus
                className={inputCls + " appearance-none"}
                style={inputStyle}
              >
                <option value="">Select…</option>
                {selectOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : (
              <input
                type={inputType}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoFocus
                placeholder={placeholder}
                className={inputCls + " [color-scheme:dark]"}
                style={inputStyle}
                onKeyDown={(e) => {
                  if (e.key === "Enter")  handleSave();
                  if (e.key === "Escape") handleCancel();
                }}
              />
            )}
            {helpText && <p className="text-xs" style={{ color: "var(--text-faint)" }}>{helpText}</p>}
            {error    && <p className="text-xs" style={{ color: "var(--accent-negative)" }}>{error}</p>}
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 text-xs font-semibold text-white disabled:opacity-50 px-2.5 py-1 rounded-lg transition-colors"
                style={{ background: "var(--accent-info)" }}
              >
                {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                Save
              </button>
              <button
                onClick={handleCancel}
                className="flex items-center gap-1.5 text-xs font-medium hover:text-[var(--text-primary)] px-2.5 py-1 rounded-lg transition-colors"
                style={{ color: "var(--text-secondary)" }}
              >
                <X size={11} /> Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm" style={{ color: "var(--text-primary)" }}>
            {curDisp
              ? <>{curDisp}{flash && <span className="ml-2 text-xs" style={{ color: "var(--accent-positive)" }}>Saved ✓</span>}</>
              : <span className="italic text-sm" style={{ color: "var(--text-faint)" }}>Not set</span>
            }
          </p>
        )}
      </div>

      {!editing && !readOnly && (
        <button
          onClick={() => { setDraft(current); setEditing(true); }}
          className="mt-4 p-1.5 rounded-lg hover:text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] transition-colors shrink-0"
          style={{ color: "var(--text-faint)" }}
        >
          <Pencil size={13} />
        </button>
      )}
    </div>
  );
}
