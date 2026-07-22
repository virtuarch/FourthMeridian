"use client";

/**
 * components/settings/SecuritySettings.tsx  (UX-1)
 *
 * Security page — one page, internally sectioned:
 *   Account Security  → Password · Email · Two-Factor
 *   Sessions
 *   Security History
 *   Danger Zone       → Deactivate · Delete
 *
 * UI-Convergence Wave 1 (W1-E) converged the presentation onto the shared kit —
 * SettingsSection cards, Atlas Field/Input for the password form, one save signal
 * (Toast success / InlineBanner error). The password VALIDATION and every API call
 * are unchanged; the other cards are the same self-contained security components.
 */

import { useState, Suspense } from "react";
import { Eye, EyeOff, Loader2, ShieldCheck, Mail, Monitor, UserX, Trash2 } from "lucide-react";
import { DataCard } from "@/components/atlas/DataCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { Field, Input } from "@/components/atlas/fields";
import { InlineBanner } from "@/components/atlas/InlineBanner";
import { useToast } from "@/components/atlas/Toast";
import { ActiveSessions } from "@/components/security/ActiveSessions";
import { SecurityHistory } from "@/components/security/SecurityHistory";
import { ChangeEmailForm } from "@/components/security/ChangeEmailForm";
import { DeactivateAccountCard } from "@/components/security/DeactivateAccountCard";
import { DeleteAccountCard } from "@/components/security/DeleteAccountCard";
import { TotpSection } from "@/components/dashboard/TotpSection";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wide pt-2" style={{ color: "var(--text-muted)" }}>
      {children}
    </p>
  );
}

/** Show/hide affordance for a password field (Input `trailing`). */
function RevealButton({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle}
      className="hover:text-[var(--text-secondary)] p-1" style={{ color: "var(--text-muted)" }}>
      {shown ? <EyeOff size={14} /> : <Eye size={14} />}
    </button>
  );
}

export function SecuritySettings({ email }: { email: string }) {
  const { toast } = useToast();
  // ── Password change (validation + API unchanged) ────────────────────────────
  const [currentPw, setCurrentPw] = useState("");
  const [newPw,     setNewPw]     = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showCur,   setShowCur]   = useState(false);
  const [showNew,   setShowNew]   = useState(false);
  const [pwError,   setPwError]   = useState("");
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

    setCurrentPw(""); setNewPw(""); setConfirmPw("");
    toast("Password updated");
  }

  return (
    <>
      {/* ── Account Security ── */}
      <SectionLabel>Account Security</SectionLabel>

      {/* Password */}
      <SettingsSection icon={ShieldCheck} title="Password">
        <form onSubmit={handlePasswordChange} className="space-y-3">
          <InlineBanner tone="error">{pwError}</InlineBanner>

          <Field label="Current password">
            <Input
              type={showCur ? "text" : "password"}
              value={currentPw}
              onChange={(e) => setCurrentPw(e.target.value)}
              required
              placeholder="••••••••"
              autoComplete="current-password"
              trailing={<RevealButton shown={showCur} onToggle={() => setShowCur((v) => !v)} />}
            />
          </Field>

          <Field label="New password">
            <Input
              type={showNew ? "text" : "password"}
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              required
              minLength={8}
              placeholder="Min. 8 characters"
              autoComplete="new-password"
              trailing={<RevealButton shown={showNew} onToggle={() => setShowNew((v) => !v)} />}
            />
          </Field>

          <Field label="Confirm new password">
            <Input
              type="password"
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              required
              placeholder="Repeat new password"
              autoComplete="new-password"
            />
          </Field>

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
      </SettingsSection>

      {/* Email */}
      <SettingsSection
        icon={Mail}
        title="Email Address"
        description="Change the email address for your account. We'll send a confirmation link to the new address."
      >
        <ChangeEmailForm currentEmail={email} />
      </SettingsSection>

      {/* Two-factor */}
      <SettingsSection icon={ShieldCheck} title="Two-Factor Authentication">
        <Suspense fallback={<div className="h-16 rounded-xl animate-pulse" style={{ background: "var(--surface-inset)" }} />}>
          <TotpSection />
        </Suspense>
      </SettingsSection>

      {/* ── Sessions ── */}
      <SectionLabel>Sessions</SectionLabel>
      <SettingsSection
        icon={Monitor}
        title="Active Sessions"
        description="Devices currently signed in to your account. Revoke any you don't recognize."
      >
        <ActiveSessions />
      </SettingsSection>

      {/* ── Recent Activity ── */}
      <SectionLabel>Recent Activity</SectionLabel>
      <DataCard>
        <SecurityHistory />
      </DataCard>

      {/* ── Danger Zone ── */}
      <SectionLabel>Danger Zone</SectionLabel>
      <SettingsSection
        icon={UserX}
        title="Deactivate Account"
        danger
        description="Temporarily deactivate your account. Your data is kept and nothing is deleted — sign in again anytime to reactivate."
      >
        <DeactivateAccountCard />
      </SettingsSection>

      <SettingsSection
        icon={Trash2}
        title="Delete Account"
        danger
        description="Permanently delete your account and all your data. You'll have 7 days to cancel by signing back in — after that it can't be undone."
      >
        <DeleteAccountCard />
      </SettingsSection>
    </>
  );
}
