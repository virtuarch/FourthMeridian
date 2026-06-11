"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Pencil, Check, X, Loader2, Eye, EyeOff, ShieldCheck, User } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";

// ── Types ────────────────────────────────────────────────────────────────────

interface Profile {
  email:            string;
  username:         string;
  firstName:        string;
  lastName:         string;
  employmentStatus: string;
  useCase:          string;
  hasDob:           boolean;
}

interface Props {
  initialProfile: Profile;
}

interface SelectOption { value: string; label: string; }

// ── Constants ────────────────────────────────────────────────────────────────

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

// ── Inline editable field ────────────────────────────────────────────────────

function InlineField({
  label,
  value,
  displayValue,
  onSave,
  inputType  = "text",
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

  const inputCls =
    "w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm " +
    "focus:outline-none focus:border-blue-500 transition-colors";

  return (
    <div className="flex items-start justify-between gap-4 py-3.5 border-b border-gray-800/60 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-xs text-gray-500 mb-0.5">{label}</p>

        {editing ? (
          <div className="mt-1.5 space-y-2">
            {selectOptions ? (
              <select
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoFocus
                className={inputCls + " appearance-none"}
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
                onKeyDown={(e) => {
                  if (e.key === "Enter")  handleSave();
                  if (e.key === "Escape") handleCancel();
                }}
              />
            )}
            {helpText && <p className="text-xs text-gray-600">{helpText}</p>}
            {error    && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-2.5 py-1 rounded-lg transition-colors"
              >
                {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                Save
              </button>
              <button
                onClick={handleCancel}
                className="flex items-center gap-1.5 text-xs font-medium text-gray-400 hover:text-white px-2.5 py-1 rounded-lg transition-colors"
              >
                <X size={11} /> Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-white">
            {curDisp
              ? <>{curDisp}{flash && <span className="ml-2 text-xs text-emerald-400">Saved ✓</span>}</>
              : <span className="text-gray-600 italic text-sm">Not set</span>
            }
          </p>
        )}
      </div>

      {!editing && !readOnly && (
        <button
          onClick={() => { setDraft(current); setEditing(true); }}
          className="mt-4 p-1.5 rounded-lg text-gray-600 hover:text-gray-300 hover:bg-gray-800 transition-colors shrink-0"
        >
          <Pencil size={13} />
        </button>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function SettingsClient({ initialProfile }: Props) {
  const { update: updateSession } = useSession();

  async function saveField(payload: Record<string, string>): Promise<string | null> {
    const res  = await fetch("/api/user/profile", {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return data.error ?? "Failed to save.";

    // Propagate username change into the JWT so the sidebar updates immediately
    if (payload.username !== undefined) {
      await updateSession({ username: payload.username });
    }
    return null;
  }

  // ── Password change ───────────────────────────────────────────────────────

  const [currentPw, setCurrentPw] = useState("");
  const [newPw,     setNewPw]     = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showCur,   setShowCur]   = useState(false);
  const [showNew,   setShowNew]   = useState(false);
  const [pwError,   setPwError]   = useState("");
  const [pwOk,      setPwOk]      = useState(false);
  const [pwBusy,    setPwBusy]    = useState(false);

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    setPwError("");
    if (newPw !== confirmPw)  { setPwError("Passwords do not match.");                   return; }
    if (newPw.length < 8)     { setPwError("New password must be at least 8 characters."); return; }
    if (newPw === currentPw)  { setPwError("New password must differ from current.");    return; }

    setPwBusy(true);
    const res  = await fetch("/api/user/password", {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
    });
    const data = await res.json().catch(() => ({}));
    setPwBusy(false);

    if (!res.ok) { setPwError(data.error ?? "Failed to update password."); return; }

    setPwOk(true);
    setCurrentPw(""); setNewPw(""); setConfirmPw("");
    setTimeout(() => setPwOk(false), 3500);
  }

  const inputCls =
    "w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm " +
    "focus:outline-none focus:border-blue-500 transition-colors";

  return (
    <div className="max-w-2xl mx-auto space-y-6 px-4 py-6">
      <h1 className="text-2xl font-bold text-white">Settings</h1>

      {/* ── Profile ── */}
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <User size={15} className="text-gray-400" />
          <CardTitle>Profile</CardTitle>
        </div>

        <InlineField
          label="Email"
          value={initialProfile.email}
          onSave={async () => null}
          readOnly
        />

        <InlineField
          label="Username"
          value={initialProfile.username}
          onSave={(val) => saveField({ username: val })}
          placeholder="e.g. janesmith"
          helpText="3–30 chars · letters, numbers, underscores · used to sign in"
        />

        <InlineField
          label="First name"
          value={initialProfile.firstName}
          onSave={(val) => saveField({ firstName: val })}
          placeholder="Jane"
        />

        <InlineField
          label="Last name"
          value={initialProfile.lastName}
          onSave={(val) => saveField({ lastName: val })}
          placeholder="Smith"
        />

        <InlineField
          label="Date of birth"
          value=""
          displayValue={initialProfile.hasDob ? "On file (encrypted)" : ""}
          onSave={(val) => saveField({ dateOfBirth: val })}
          inputType="date"
          helpText="Stored encrypted · used for age-appropriate financial advice"
        />

        <InlineField
          label="Employment status"
          value={initialProfile.employmentStatus}
          displayValue={EMPLOYMENT_LABELS[initialProfile.employmentStatus] ?? ""}
          onSave={(val) => saveField({ employmentStatus: val })}
          selectOptions={EMPLOYMENT_OPTIONS}
        />

        <InlineField
          label="Primary use case"
          value={initialProfile.useCase}
          displayValue={USE_CASE_LABELS[initialProfile.useCase] ?? ""}
          onSave={(val) => saveField({ useCase: val })}
          selectOptions={USE_CASE_OPTIONS}
        />
      </Card>

      {/* ── Security ── */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck size={15} className="text-gray-400" />
          <CardTitle>Security</CardTitle>
        </div>

        <form onSubmit={handlePasswordChange} className="space-y-3">
          {pwError && (
            <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-3 py-2.5 text-sm text-red-400">
              {pwError}
            </div>
          )}
          {pwOk && (
            <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-3 py-2.5 text-sm text-emerald-400">
              Password updated successfully.
            </div>
          )}

          <div>
            <label className="block text-xs text-gray-500 mb-1.5">Current password</label>
            <div className="relative">
              <input
                type={showCur ? "text" : "password"}
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
                required
                className={inputCls + " pr-10"}
                placeholder="••••••••"
                autoComplete="current-password"
              />
              <button type="button" onClick={() => setShowCur((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 p-1">
                {showCur ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1.5">New password</label>
            <div className="relative">
              <input
                type={showNew ? "text" : "password"}
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                required
                minLength={8}
                className={inputCls + " pr-10"}
                placeholder="Min. 8 characters"
                autoComplete="new-password"
              />
              <button type="button" onClick={() => setShowNew((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 p-1">
                {showNew ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1.5">Confirm new password</label>
            <input
              type="password"
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              required
              className={inputCls}
              placeholder="Repeat new password"
              autoComplete="new-password"
            />
          </div>

          <button
            type="submit"
            disabled={pwBusy || !currentPw || !newPw || !confirmPw}
            className="flex items-center gap-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2.5 rounded-xl transition-colors"
          >
            {pwBusy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            Update Password
          </button>
        </form>
      </Card>
    </div>
  );
}
