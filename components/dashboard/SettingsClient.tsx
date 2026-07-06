"use client";

import { FX_BASE, SUPPORTED_QUOTES } from "@/lib/fx/config";
import { useState, Suspense } from "react";
import { useSession } from "next-auth/react";
import { Pencil, Check, X, Loader2, Eye, EyeOff, ShieldCheck, User, LayoutDashboard, Archive, ChevronRight, Monitor, History, Mail, UserX, Trash2 } from "lucide-react";
import { DataCard, DataCardTitle } from "@/components/atlas/DataCard";
import { ActiveSessions } from "@/components/security/ActiveSessions";
import { SecurityHistory } from "@/components/security/SecurityHistory";
import { ChangeEmailForm } from "@/components/security/ChangeEmailForm";
import { DeactivateAccountCard } from "@/components/security/DeactivateAccountCard";
import { DeleteAccountCard } from "@/components/security/DeleteAccountCard";
import { TotpSection } from "@/components/dashboard/TotpSection";
import { displaySpaceName } from "@/lib/format";
import Link from "next/link";

// ── Types ────────────────────────────────────────────────────────────────────

interface Profile {
  email:                string;
  username:             string;
  firstName:            string;
  lastName:             string;
  employmentStatus:     string;
  /** MC1 Phase 4 Slice 2 — user default reporting currency (copy-once seed for new Spaces). */
  reportingCurrency:    string;
  useCase:              string;
  hasDob:               boolean;
  preferredSpaceId: string | null;
}

interface SpaceOption {
  id:   string;
  name: string;
  type: string;
}

interface Props {
  initialProfile: Profile;
  spaces:     SpaceOption[];
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

// MC1 Phase 4 Slice 2 (plan D-3) — approved reporting currencies (FX_BASE +
// SUPPORTED_QUOTES; same allowlist the API enforces).
const CURRENCY_OPTIONS: SelectOption[] = [FX_BASE, ...SUPPORTED_QUOTES].map((c) => ({ value: c, label: c }));
const USE_CASE_LABELS   = Object.fromEntries(USE_CASE_OPTIONS.map((o)   => [o.value, o.label]));

// ── Shared input styling (Atlas tokens) ──────────────────────────────────────
const INPUT_BASE = "w-full border rounded-lg text-sm focus:outline-none focus:border-[var(--accent-info)] transition-colors placeholder:text-[var(--text-faint)]";
const inputStyle: React.CSSProperties = { background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-primary)" };

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

// ── Preferred space card ─────────────────────────────────────────────────

function PreferredSpaceCard({
  spaces,
  initialPreferredId,
  saveField,
}: {
  spaces:          SpaceOption[];
  initialPreferredId:  string | null;
  saveField:           (payload: Record<string, string>) => Promise<string | null>;
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

// ── Main component ────────────────────────────────────────────────────────────

export function SettingsClient({ initialProfile, spaces }: Props) {
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

  const inputCls = INPUT_BASE + " px-3 py-2.5";

  return (
    <div className="max-w-2xl mx-auto space-y-6 px-4 py-6">
      <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>Settings</h1>

      {/* ── Profile ── */}
      <DataCard>
        <div className="flex items-center gap-2 mb-1">
          <User size={15} style={{ color: "var(--text-secondary)" }} />
          <DataCardTitle>Profile</DataCardTitle>
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
          label="Default reporting currency"
          value={initialProfile.reportingCurrency}
          displayValue={initialProfile.reportingCurrency}
          onSave={(val) => saveField({ reportingCurrency: val })}
          selectOptions={CURRENCY_OPTIONS}
          helpText="Default for new Spaces you create. Changing it never affects existing Spaces."
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
      </DataCard>

      {/* ── Preferred space ── */}
      <PreferredSpaceCard
        spaces={spaces}
        initialPreferredId={initialProfile.preferredSpaceId}
        saveField={saveField}
      />

      {/* ── Security ── */}
      <DataCard>
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck size={15} style={{ color: "var(--text-secondary)" }} />
          <DataCardTitle>Security</DataCardTitle>
        </div>

        <form onSubmit={handlePasswordChange} className="space-y-3">
          {pwError && (
            <div className="rounded-xl border px-3 py-2.5 text-sm" style={{ background: "rgba(237,82,71,0.10)", borderColor: "rgba(237,82,71,0.30)", color: "var(--accent-negative)" }}>
              {pwError}
            </div>
          )}
          {pwOk && (
            <div className="rounded-xl border px-3 py-2.5 text-sm" style={{ background: "rgba(34,197,94,0.10)", borderColor: "rgba(34,197,94,0.30)", color: "var(--accent-positive)" }}>
              Password updated successfully.
            </div>
          )}

          <div>
            <label className="block text-xs mb-1.5" style={{ color: "var(--text-muted)" }}>Current password</label>
            <div className="relative">
              <input
                type={showCur ? "text" : "password"}
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
                required
                className={inputCls + " pr-10"}
                style={inputStyle}
                placeholder="••••••••"
                autoComplete="current-password"
              />
              <button type="button" onClick={() => setShowCur((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 hover:text-[var(--text-secondary)] p-1" style={{ color: "var(--text-muted)" }}>
                {showCur ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs mb-1.5" style={{ color: "var(--text-muted)" }}>New password</label>
            <div className="relative">
              <input
                type={showNew ? "text" : "password"}
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                required
                minLength={8}
                className={inputCls + " pr-10"}
                style={inputStyle}
                placeholder="Min. 8 characters"
                autoComplete="new-password"
              />
              <button type="button" onClick={() => setShowNew((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 hover:text-[var(--text-secondary)] p-1" style={{ color: "var(--text-muted)" }}>
                {showNew ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs mb-1.5" style={{ color: "var(--text-muted)" }}>Confirm new password</label>
            <input
              type="password"
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              required
              className={inputCls}
              style={inputStyle}
              placeholder="Repeat new password"
              autoComplete="new-password"
            />
          </div>

          <button
            type="submit"
            disabled={pwBusy || !currentPw || !newPw || !confirmPw}
            className="flex items-center gap-2 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2.5 rounded-xl transition-colors"
            style={{ background: "var(--accent-info)" }}
          >
            {pwBusy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            Update Password
          </button>
        </form>
      </DataCard>

      {/* ── Email address (OPS-2 S3a) ── */}
      <DataCard>
        <div className="flex items-center gap-2 mb-1">
          <Mail size={15} style={{ color: "var(--text-secondary)" }} />
          <DataCardTitle>Email Address</DataCardTitle>
        </div>
        <p className="text-xs mb-4" style={{ color: "var(--text-faint)" }}>
          Change the email address for your account. We&apos;ll send a confirmation
          link to the new address.
        </p>
        <ChangeEmailForm currentEmail={initialProfile.email} />
      </DataCard>

      {/* ── Two-factor authentication ── */}
      <DataCard>
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck size={15} style={{ color: "var(--text-secondary)" }} />
          <DataCardTitle>Two-Factor Authentication</DataCardTitle>
        </div>
        <Suspense fallback={<div className="h-16 rounded-xl animate-pulse" style={{ background: "var(--surface-inset)" }} />}>
          <TotpSection />
        </Suspense>
      </DataCard>

      {/* ── Active sessions (OPS-2 S1) ── */}
      <DataCard>
        <div className="flex items-center gap-2 mb-1">
          <Monitor size={15} style={{ color: "var(--text-secondary)" }} />
          <DataCardTitle>Active Sessions</DataCardTitle>
        </div>
        <p className="text-xs mb-4" style={{ color: "var(--text-faint)" }}>
          Devices currently signed in to your account. Revoke any you don&apos;t recognize.
        </p>
        <ActiveSessions />
      </DataCard>

      {/* ── Security history (OPS-2 S1) ── */}
      <DataCard>
        <div className="flex items-center gap-2 mb-1">
          <History size={15} style={{ color: "var(--text-secondary)" }} />
          <DataCardTitle>Security History</DataCardTitle>
        </div>
        <p className="text-xs mb-4" style={{ color: "var(--text-faint)" }}>
          Recent sign-ins and security changes on your account.
        </p>
        <SecurityHistory />
      </DataCard>

      {/* ── Data & Archive ── */}
      <DataCard>
        <div className="flex items-center gap-2 mb-1">
          <Archive size={15} style={{ color: "var(--text-secondary)" }} />
          <DataCardTitle>Data & Archive</DataCardTitle>
        </div>
        <p className="text-xs mb-4" style={{ color: "var(--text-faint)" }}>
          Manage archived accounts and Spaces. Restore them, or remove them permanently.
        </p>

        <Link
          href="/dashboard/settings/archived-assets"
          className="flex items-center justify-between px-4 py-3 rounded-xl border hover:bg-[var(--surface-hover)] transition-colors group"
          style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "var(--surface-hover-strong)" }}>
              <Archive size={14} style={{ color: "var(--text-secondary)" }} />
            </div>
            <div>
              <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Archive &amp; Trash</p>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Archived accounts, archived Spaces, and trash</p>
            </div>
          </div>
          <ChevronRight size={15} style={{ color: "var(--text-faint)" }} />
        </Link>
      </DataCard>

      {/* ── Deactivate account (OPS-2 S4) ── */}
      <DataCard>
        <div className="flex items-center gap-2 mb-1">
          <UserX size={15} style={{ color: "var(--accent-negative)" }} />
          <DataCardTitle>Deactivate Account</DataCardTitle>
        </div>
        <p className="text-xs mb-4" style={{ color: "var(--text-faint)" }}>
          Temporarily deactivate your account. Your data is kept and nothing is
          deleted — sign in again anytime to reactivate.
        </p>
        <DeactivateAccountCard />
      </DataCard>

      {/* ── Delete account (OPS-2 S7b) ── */}
      <DataCard>
        <div className="flex items-center gap-2 mb-1">
          <Trash2 size={15} style={{ color: "var(--accent-negative)" }} />
          <DataCardTitle>Delete Account</DataCardTitle>
        </div>
        <p className="text-xs mb-4" style={{ color: "var(--text-faint)" }}>
          Permanently delete your account and all your data. You&apos;ll have 7
          days to cancel by signing back in — after that it can&apos;t be undone.
        </p>
        <DeleteAccountCard />
      </DataCard>
    </div>
  );
}
