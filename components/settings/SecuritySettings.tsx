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
 * All pieces are reused, not rewritten: the password form is lifted verbatim
 * from the former SettingsClient.tsx; every other card is an existing
 * self-contained security component. No API or validation changes.
 */

import { useState, Suspense } from "react";
import { Eye, EyeOff, Loader2, ShieldCheck, Mail, Monitor, UserX, Trash2 } from "lucide-react";
import { DataCard, DataCardTitle } from "@/components/atlas/DataCard";
import { INPUT_BASE, inputStyle } from "@/components/settings/InlineField";
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

export function SecuritySettings({ email }: { email: string }) {
  // ── Password change (moved verbatim from SettingsClient) ────────────────────
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
    <>
      {/* ── Account Security ── */}
      <SectionLabel>Account Security</SectionLabel>

      {/* Password */}
      <DataCard>
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck size={15} style={{ color: "var(--text-secondary)" }} />
          <DataCardTitle>Password</DataCardTitle>
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

      {/* Email */}
      <DataCard>
        <div className="flex items-center gap-2 mb-1">
          <Mail size={15} style={{ color: "var(--text-secondary)" }} />
          <DataCardTitle>Email Address</DataCardTitle>
        </div>
        <p className="text-xs mb-4" style={{ color: "var(--text-faint)" }}>
          Change the email address for your account. We&apos;ll send a confirmation
          link to the new address.
        </p>
        <ChangeEmailForm currentEmail={email} />
      </DataCard>

      {/* Two-factor */}
      <DataCard>
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck size={15} style={{ color: "var(--text-secondary)" }} />
          <DataCardTitle>Two-Factor Authentication</DataCardTitle>
        </div>
        <Suspense fallback={<div className="h-16 rounded-xl animate-pulse" style={{ background: "var(--surface-inset)" }} />}>
          <TotpSection />
        </Suspense>
      </DataCard>

      {/* ── Sessions ── */}
      <SectionLabel>Sessions</SectionLabel>
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

      {/* ── Recent Activity ── */}
      <SectionLabel>Recent Activity</SectionLabel>
      <DataCard>
        <SecurityHistory />
      </DataCard>

      {/* ── Danger Zone ── */}
      <SectionLabel>Danger Zone</SectionLabel>
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
    </>
  );
}
