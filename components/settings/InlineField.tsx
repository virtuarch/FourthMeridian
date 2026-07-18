"use client";

/**
 * components/settings/InlineField.tsx
 *
 * Inline-editable field row for the Settings sections. UI-Convergence Wave 1
 * (W1-E) rebuilt its internals on the shared Atlas field kit (Input / Select /
 * HelpText / FieldError) and routes success through the shared Toast — retiring the
 * bespoke input markup and the local "Saved ✓" flash. The public API is unchanged
 * (label / value / onSave / … ), so Account and Preferences call it exactly as
 * before. INPUT_BASE / inputStyle are re-exported for the pre-existing importers
 * outside Settings (SecurityHistory, DebtClient, transaction widgets).
 */

import { useState } from "react";
import { Pencil, Check, X, Loader2 } from "lucide-react";
import { Input, Select, HelpText, FieldError, type SelectOption, type FieldSaveFn } from "@/components/atlas/fields";
import { useToast } from "@/components/atlas/Toast";

export { INPUT_BASE, inputStyle } from "@/components/atlas/fields";
export type { SelectOption };

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
  onSave:         FieldSaveFn;
  inputType?:     string;
  placeholder?:   string;
  helpText?:      string;
  selectOptions?: SelectOption[];
  readOnly?:      boolean;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(value);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState("");
  const [current, setCurrent] = useState(value);
  const [curDisp, setCurDisp] = useState(displayValue ?? value);

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
      toast(`${label} saved`);
    }
  }

  function handleCancel() { setDraft(current); setError(""); setEditing(false); }

  return (
    <div className="flex items-start justify-between gap-4 py-3.5 border-b last:border-0" style={{ borderColor: "var(--border-hairline)" }}>
      <div className="flex-1 min-w-0">
        <p className="text-xs mb-0.5" style={{ color: "var(--text-muted)" }}>{label}</p>

        {editing ? (
          <div className="mt-1.5 space-y-2">
            {selectOptions ? (
              <Select
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoFocus
                placeholder="Select…"
                options={selectOptions}
              />
            ) : (
              <Input
                type={inputType}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoFocus
                placeholder={placeholder}
                onKeyDown={(e) => {
                  if (e.key === "Enter")  handleSave();
                  if (e.key === "Escape") handleCancel();
                }}
              />
            )}
            {helpText && <HelpText>{helpText}</HelpText>}
            <FieldError>{error}</FieldError>
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-white transition-colors disabled:opacity-50 lg:min-h-0 lg:py-1"
                style={{ background: "var(--accent-info)" }}
              >
                {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                Save
              </button>
              <button
                onClick={handleCancel}
                className="flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors hover:text-[var(--text-primary)] lg:min-h-0 lg:py-1"
                style={{ color: "var(--text-secondary)" }}
              >
                <X size={11} /> Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm" style={{ color: "var(--text-primary)" }}>
            {curDisp
              ? curDisp
              : <span className="italic text-sm" style={{ color: "var(--text-faint)" }}>Not set</span>
            }
          </p>
        )}
      </div>

      {!editing && !readOnly && (
        <button
          aria-label={`Edit ${label}`}
          onClick={() => { setDraft(current); setEditing(true); }}
          className="mt-2 grid size-10 shrink-0 place-items-center rounded-lg transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)] lg:mt-4 lg:size-auto lg:p-1.5"
          style={{ color: "var(--text-faint)" }}
        >
          <Pencil size={13} />
        </button>
      )}
    </div>
  );
}
