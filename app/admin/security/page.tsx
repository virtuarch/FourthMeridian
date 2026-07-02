"use client";

/**
 * app/admin/security/page.tsx — Security Admin Dashboard
 *
 * Sections:
 * 1. Platform Authentication Settings
 * 2. Current Admin 2FA Status + Active Sessions
 * 3. User Security Management (lookup + actions + sessions modal)
 */

import React, { useState, useEffect, useCallback, Suspense } from "react";
import {
  ShieldAlert, ShieldCheck, ShieldOff, RefreshCw, Key, LogOut,
  Search, X, AlertTriangle, CheckCircle2, Copy, Eye, EyeOff,
  ChevronDown, ChevronUp, Monitor, Smartphone, Tablet, Globe,
} from "lucide-react";
import { ParsedUA } from "@/lib/ua-parser";
import { TotpSection } from "@/components/dashboard/TotpSection";
import { formatDateTime } from "@/lib/format";

// ─── Types ────────────────────────────────────────────────────────────────────

type Settings = {
  require_totp_system_admin: string;
  require_totp_admins:       string;
  require_totp_all_users:    string;
  recovery_codes_enabled:    string;
  min_password_length:       string;
};

type AdminStatus = {
  userId:                 string;
  totpEnabled:            boolean;
  totpConfigured:         boolean;
  recoveryCodesRemaining: number;
  activeSessions:         number;
  lastLogin:              string | null;
  lastLoginIp:            string | null;
  lastCodeGeneration:     string | null;
};

type SessionRow = {
  id:           string;
  userId:       string;
  sessionToken: string;
  ipAddress:    string | null;
  userAgent:    string | null;
  lastActiveAt: string;
  revokedAt:    string | null;
  createdAt:    string;
  isCurrent?:   boolean;
  parsed:       ParsedUA;
};

type SecurityUser = {
  id:                     string;
  email:                  string;
  username:               string | null;
  name:                   string | null;
  firstName:              string | null;
  lastName:               string | null;
  role:                   string;
  totpEnabled:            boolean;
  forcePasswordReset:     boolean;
  recoveryCodesRemaining: number;
  activeSessionCount:     number;
  lastLogin:              string | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDateTime(d: string | null) {
  if (!d) return "Never";
  return formatDateTime(d);
}

function fmtRelative(d: string | null) {
  if (!d) return "—";
  const diff = Date.now() - new Date(d).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins < 1)    return "Just now";
  if (mins < 60)   return `${mins}m ago`;
  if (hours < 24)  return `${hours}h ago`;
  return `${days}d ago`;
}

function DeviceIcon({ device }: { device: string }) {
  if (/phone|iphone|android phone/i.test(device)) return <Smartphone size={13} className="text-gray-400" />;
  if (/tablet|ipad/i.test(device))                return <Tablet      size={13} className="text-gray-400" />;
  return <Monitor size={13} className="text-gray-400" />;
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border transition-colors focus:outline-none ${
        disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"
      } ${checked ? "bg-emerald-500 border-emerald-400" : "bg-gray-700 border-gray-600"}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform mt-0.5 ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900/60 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-800/60">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

// ── Sessions List (shared between admin-self and user views) ──────────────────

function SessionsList({
  sessions,
  onRevoke,
  onRevokeAll,
  revokeAllLabel = "Revoke all other sessions",
  showRevokeAll  = true,
}: {
  sessions:       SessionRow[];
  onRevoke:       (id: string, isCurrent: boolean) => Promise<void>;
  onRevokeAll:    () => Promise<void>;
  revokeAllLabel?: string;
  showRevokeAll?:  boolean;
}) {
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmSelfId, setConfirmSelfId] = useState<string | null>(null);

  const active = sessions.filter((s) => !s.revokedAt);
  const revoked = sessions.filter((s) => s.revokedAt);

  async function handleRevoke(s: SessionRow) {
    if (s.isCurrent && confirmSelfId !== s.id) {
      setConfirmSelfId(s.id);
      return;
    }
    setRevoking(s.id);
    await onRevoke(s.id, !!s.isCurrent);
    setRevoking(null);
    setConfirmSelfId(null);
  }

  if (sessions.length === 0) {
    return <p className="text-xs text-gray-600 py-4 text-center">No sessions recorded yet.</p>;
  }

  return (
    <div className="space-y-4">
      {/* Active sessions */}
      {active.length > 0 && (
        <div className="space-y-2">
          {active.map((s) => (
            <div
              key={s.id}
              className={`flex items-start justify-between gap-3 p-3 rounded-xl border transition-colors ${
                s.isCurrent
                  ? "bg-blue-500/5 border-blue-500/20"
                  : "bg-gray-800/30 border-gray-800"
              }`}
            >
              <div className="flex items-start gap-2.5 min-w-0">
                <div className="mt-0.5 shrink-0">
                  <DeviceIcon device={s.parsed.device} />
                </div>
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-white">{s.parsed.browser}</span>
                    <span className="text-xs text-gray-500">on {s.parsed.os}</span>
                    <span className="text-xs text-gray-600">· {s.parsed.device}</span>
                    {s.isCurrent && (
                      <span className="text-xs font-medium text-blue-400 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded-full">
                        Current
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    {s.ipAddress && (
                      <span className="flex items-center gap-1 text-xs text-gray-600 font-mono">
                        <Globe size={10} /> {s.ipAddress}
                      </span>
                    )}
                    <span className="text-xs text-gray-600">Started {fmtDateTime(s.createdAt)}</span>
                    <span className="text-xs text-gray-600" suppressHydrationWarning>Active {fmtRelative(s.lastActiveAt)}</span>
                  </div>
                  {confirmSelfId === s.id && (
                    <p className="text-xs text-amber-400 mt-1">
                      This is your current session. Click Revoke again to confirm.
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleRevoke(s)}
                disabled={revoking === s.id}
                className={`shrink-0 text-xs px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-40 ${
                  confirmSelfId === s.id
                    ? "bg-red-500/20 border-red-500/40 text-red-400 hover:bg-red-500/30"
                    : "bg-gray-800 border-gray-700 text-gray-500 hover:text-red-400 hover:border-red-500/30"
                }`}
              >
                {revoking === s.id ? "…" : confirmSelfId === s.id ? "Confirm" : "Revoke"}
              </button>
            </div>
          ))}
        </div>
      )}

      {active.length === 0 && <p className="text-xs text-gray-600 text-center py-2">No active sessions.</p>}

      {/* Revoke all button */}
      {showRevokeAll && active.filter((s) => !s.isCurrent).length > 0 && (
        <button
          onClick={onRevokeAll}
          className="flex items-center gap-1.5 text-xs text-orange-400 hover:text-orange-300 border border-orange-500/20 hover:border-orange-500/40 px-3 py-1.5 rounded-lg transition-colors"
        >
          <LogOut size={11} />
          {revokeAllLabel}
        </button>
      )}

      {/* Recently revoked */}
      {revoked.length > 0 && (
        <details className="group">
          <summary className="text-xs text-gray-600 cursor-pointer hover:text-gray-400 transition-colors list-none flex items-center gap-1.5 pt-2 border-t border-gray-800/60">
            <ChevronDown size={11} className="group-open:rotate-180 transition-transform" />
            {revoked.length} revoked / expired session{revoked.length !== 1 ? "s" : ""}
          </summary>
          <div className="mt-2 space-y-1.5">
            {revoked.map((s) => (
              <div key={s.id} className="flex items-center gap-2.5 p-2.5 rounded-xl bg-gray-800/20 border border-gray-800/40 opacity-50">
                <DeviceIcon device={s.parsed.device} />
                <div className="min-w-0">
                  <p className="text-xs text-gray-500">{s.parsed.browser} on {s.parsed.os}</p>
                  <p className="text-xs text-gray-700">Revoked {fmtDateTime(s.revokedAt)}</p>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ── 2FA Reset Modal ────────────────────────────────────────────────────────────

function ResetTwoFaModal({ user, onClose, onSuccess }: { user: SecurityUser; onClose: () => void; onSuccess: () => void }) {
  const [confirm,  setConfirm]  = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");

  async function handleReset() {
    if (confirm !== "RESET") { setError("Type RESET to confirm."); return; }
    setLoading(true); setError("");
    try {
      const res  = await fetch(`/api/admin/security/users/${user.id}/2fa-reset`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ confirmToken: "RESET", adminTotpCode: totpCode || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Reset failed."); return; }
      onSuccess(); onClose();
    } catch { setError("Network error. Try again."); }
    finally  { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md bg-gray-900 border border-red-900/40 rounded-2xl shadow-2xl">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-800">
          <div className="w-8 h-8 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center justify-center">
            <AlertTriangle size={16} className="text-red-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">Reset 2FA</h3>
            <p className="text-xs text-gray-400">{user.email}</p>
          </div>
          <button onClick={onClose} className="ml-auto text-gray-600 hover:text-gray-400"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div className="p-3 rounded-xl bg-red-500/5 border border-red-500/20 space-y-1.5">
            <p className="text-xs font-semibold text-red-400">This action will:</p>
            <ul className="text-xs text-gray-400 space-y-1 ml-2">
              <li>• Remove the user&apos;s registered authenticator devices</li>
              <li>• Require the user to set up 2FA again on next login</li>
              <li>• Invalidate all existing recovery codes</li>
              <li>• Write a TWO_FACTOR_RESET event to the audit log</li>
            </ul>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">Type <span className="font-mono font-bold text-white">RESET</span> to confirm</label>
            <input value={confirm} onChange={(e) => setConfirm(e.target.value.toUpperCase())} placeholder="RESET"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm font-mono text-white placeholder-gray-600 focus:outline-none focus:border-red-500/50" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">Your TOTP code <span className="text-gray-600">(required if your 2FA is enabled)</span></label>
            <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} placeholder="000000" maxLength={6} inputMode="numeric"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm font-mono text-white placeholder-gray-600 focus:outline-none focus:border-gray-600" />
            <p className="text-xs text-gray-600 mt-1">Leave blank if your 2FA is not yet enabled.</p>
          </div>
          {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-800">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">Cancel</button>
          <button onClick={handleReset} disabled={loading || confirm !== "RESET"}
            className="px-4 py-2 rounded-xl text-sm font-medium bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {loading ? "Resetting…" : "Reset 2FA"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Recovery Codes Modal ───────────────────────────────────────────────────────

function RecoveryCodesModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [codes,   setCodes]   = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [confirm, setConfirm] = useState("");
  const [step,    setStep]    = useState<"confirm" | "codes">("confirm");
  const [copied,  setCopied]  = useState(false);
  const [visible, setVisible] = useState(false);

  async function generate() {
    if (confirm !== "REGENERATE") { setError("Type REGENERATE to confirm."); return; }
    setLoading(true); setError("");
    try {
      const res  = await fetch(`/api/admin/security/users/${userId}/recovery-codes`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body:   JSON.stringify({ confirmToken: "REGENERATE" }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed."); return; }
      setCodes(data.codes); setStep("codes");
    } catch { setError("Network error."); }
    finally  { setLoading(false); }
  }

  function copyAll() {
    navigator.clipboard.writeText(codes.join("\n"));
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-800">
          <Key size={16} className="text-amber-400" />
          <h3 className="text-sm font-semibold text-white">{step === "confirm" ? "Regenerate Recovery Codes" : "New Recovery Codes"}</h3>
          <button onClick={onClose} className="ml-auto text-gray-600 hover:text-gray-400"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          {step === "confirm" ? (
            <>
              <p className="text-xs text-gray-400">This will invalidate all existing unused codes and generate 10 new ones. Shown <span className="text-white font-medium">once only</span>.</p>
              <div>
                <label className="block text-xs text-gray-500 mb-1.5">Type <span className="font-mono font-bold text-white">REGENERATE</span> to confirm</label>
                <input value={confirm} onChange={(e) => setConfirm(e.target.value.toUpperCase())} placeholder="REGENERATE"
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm font-mono text-white placeholder-gray-600 focus:outline-none focus:border-gray-600" />
              </div>
              {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}
            </>
          ) : (
            <>
              <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/20">
                <p className="text-xs text-amber-400 font-semibold">Store these codes securely.</p>
                <p className="text-xs text-gray-400 mt-0.5">They will not be shown again.</p>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <button onClick={() => setVisible((v) => !v)} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors">
                    {visible ? <EyeOff size={12} /> : <Eye size={12} />} {visible ? "Hide codes" : "Show codes"}
                  </button>
                  <button onClick={copyAll} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors">
                    {copied ? <CheckCircle2 size={12} className="text-emerald-400" /> : <Copy size={12} />} {copied ? "Copied!" : "Copy all"}
                  </button>
                </div>
                <div className="bg-gray-800/60 rounded-xl p-3 font-mono text-sm space-y-1">
                  {codes.map((code, i) => (
                    <p key={i} className={`${visible ? "text-white" : "text-gray-800 select-none"} tabular-nums`}>
                      {visible ? code : "••••••••-••••••••"}
                    </p>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-800">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
            {step === "codes" ? "Done" : "Cancel"}
          </button>
          {step === "confirm" && (
            <button onClick={generate} disabled={loading || confirm !== "REGENERATE"}
              className="px-4 py-2 rounded-xl text-sm font-medium bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              {loading ? "Generating…" : "Generate codes"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── User Sessions Modal (admin viewing another user's sessions) ────────────────

function UserSessionsModal({ user, onClose }: { user: SecurityUser; onClose: () => void }) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading,  setLoading]  = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res  = await fetch(`/api/admin/security/users/${user.id}/sessions`);
    const data = await res.json();
    setSessions(data.sessions ?? []);
    setLoading(false);
  }, [user.id]);

  useEffect(() => {
    const t = setTimeout(() => load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function revoke(sessionId: string) {
    await fetch(`/api/admin/security/users/${user.id}/sessions?sessionId=${sessionId}`, { method: "DELETE" });
    load();
  }

  async function revokeAll() {
    await fetch(`/api/admin/security/users/${user.id}/sessions`, { method: "DELETE" });
    load();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-800 shrink-0">
          <Monitor size={16} className="text-blue-400" />
          <div>
            <h3 className="text-sm font-semibold text-white">Active Sessions</h3>
            <p className="text-xs text-gray-400">{user.email}</p>
          </div>
          <button onClick={onClose} className="ml-auto text-gray-600 hover:text-gray-400"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 overflow-y-auto">
          {loading ? (
            <p className="text-xs text-gray-600 text-center py-6">Loading…</p>
          ) : (
            <SessionsList
              sessions={sessions}
              onRevoke={async (id) => { await revoke(id); }}
              onRevokeAll={revokeAll}
              revokeAllLabel="Revoke all sessions for this user"
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function AdminSecurityPage() {
  const [settings,       setSettings]       = useState<Settings | null>(null);
  const [adminStatus,    setAdminStatus]    = useState<AdminStatus | null>(null);
  const [adminSessions,  setAdminSessions]  = useState<SessionRow[]>([]);
  const [users,          setUsers]          = useState<SecurityUser[]>([]);
  const [userSearch,     setUserSearch]     = useState("");
  const [selectedUser,   setSelectedUser]   = useState<SecurityUser | null>(null);
  const [expandedUser,   setExpandedUser]   = useState<string | null>(null);
  const [modal,          setModal]          = useState<"reset2fa" | "recoveryCodes" | "userSessions" | null>(null);
  const [toast,          setToast]          = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);

  function showToast(msg: string, type: "success" | "error" = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  const fetchSettings    = useCallback(async () => {
    const res = await fetch("/api/admin/security/settings");
    if (!res.ok) return;
    const data = await res.json();
    setSettings(data.settings ?? null);
  }, []);

  const fetchAdminStatus = useCallback(async () => {
    const res = await fetch("/api/admin/security/admin-status");
    if (!res.ok) return;
    const data = await res.json();
    setAdminStatus(data);
  }, []);

  const fetchAdminSessions = useCallback(async () => {
    const res  = await fetch("/api/user/sessions");
    if (!res.ok) return;
    const data = await res.json();
    setAdminSessions(data.sessions ?? []);
  }, []);

  const fetchUsers = useCallback(async (search = "") => {
    const params = search ? `?search=${encodeURIComponent(search)}` : "";
    const res    = await fetch(`/api/admin/security/users${params}`);
    if (!res.ok) return;
    const data   = await res.json();
    setUsers(data.users ?? []);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      fetchSettings();
      fetchAdminStatus();
      fetchAdminSessions();
      fetchUsers();
    }, 0);
    return () => clearTimeout(t);
  }, [fetchSettings, fetchAdminStatus, fetchAdminSessions, fetchUsers]);

  useEffect(() => {
    const t = setTimeout(() => fetchUsers(userSearch), 300);
    return () => clearTimeout(t);
  }, [userSearch, fetchUsers]);

  async function updateSetting(key: keyof Settings, value: string) {
    if (!settings) return;
    setSettingsSaving(true);
    const optimistic = { ...settings, [key]: value };
    setSettings(optimistic);
    try {
      const res  = await fetch("/api/admin/security/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body:   JSON.stringify([{ key, value }]),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error ?? "Failed to save.", "error"); setSettings(settings); return; }
      setSettings(data.settings);
      showToast("Setting saved.");
    } catch {
      showToast("Network error.", "error"); setSettings(settings);
    } finally { setSettingsSaving(false); }
  }

  async function revokeUserAllSessions(userId: string) {
    const res = await fetch(`/api/admin/security/users/${userId}/sessions`, { method: "DELETE" });
    if (res.ok) { showToast("All sessions revoked."); fetchUsers(userSearch); }
    else          showToast("Failed to revoke sessions.", "error");
  }

  // Admin self-session handlers
  async function revokeAdminSession(sessionId: string, isCurrent: boolean) {
    const url = isCurrent
      ? `/api/user/sessions/${sessionId}?confirmSelf=true`
      : `/api/user/sessions/${sessionId}`;
    const res = await fetch(url, { method: "DELETE" });
    if (res.ok) { showToast("Session revoked."); fetchAdminSessions(); fetchAdminStatus(); }
    else          showToast("Failed to revoke session.", "error");
  }

  async function revokeAllOtherAdminSessions() {
    const res = await fetch("/api/user/sessions", { method: "DELETE" });
    if (res.ok) { showToast("All other sessions revoked."); fetchAdminSessions(); fetchAdminStatus(); }
    else          showToast("Failed.", "error");
  }

  const filteredUsers = users.filter((u) => {
    if (!userSearch) return true;
    const q = userSearch.toLowerCase();
    return (
      u.email.toLowerCase().includes(q) ||
      (u.username  ?? "").toLowerCase().includes(q) ||
      (u.name      ?? "").toLowerCase().includes(q) ||
      (u.firstName ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-8 max-w-4xl">

      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-lg border text-sm font-medium ${
          toast.type === "success"
            ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
            : "bg-red-500/10 border-red-500/30 text-red-400"
        }`}>
          {toast.type === "success" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          {toast.msg}
        </div>
      )}

      {/* Page header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-red-500/10 border border-red-500/30 flex items-center justify-center">
          <ShieldAlert size={18} className="text-red-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">Security</h1>
          <p className="text-sm text-gray-400 mt-0.5">Platform authentication, 2FA management, and session controls</p>
        </div>
      </div>

      {/* ── 1: Platform Auth Settings ─────────────────────────────────────────── */}
      <SectionCard title="Platform Authentication Settings">
        {!settings ? <p className="text-sm text-gray-600">Loading…</p> : (
          <div className="space-y-4">
            {/* Locked row — require_totp_system_admin is always enforced */}
            <div className="flex items-start justify-between gap-4 py-3 border-b border-gray-800/40">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm text-white font-medium">Require TOTP for SYSTEM_ADMIN</p>
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">Always on</span>
                </div>
                <p className="text-xs text-gray-500 mt-0.5">SYSTEM_ADMIN accounts must always use 2FA. This cannot be disabled.</p>
              </div>
              {/* Non-interactive locked toggle */}
              <div className="shrink-0 w-9 h-5 rounded-full bg-emerald-500/30 border border-emerald-500/30 flex items-center px-0.5 cursor-not-allowed" title="Locked — always required">
                <div className="w-4 h-4 rounded-full bg-emerald-400 ml-auto" />
              </div>
            </div>

            {([
              { key: "require_totp_admins"     as const, label: "Require TOTP for all Admins", desc: "Any ADMIN Space role must have 2FA enabled." },
              { key: "require_totp_all_users"  as const, label: "Require TOTP for all users",  desc: "All users must set up 2FA before accessing the dashboard." },
              { key: "recovery_codes_enabled"  as const, label: "Recovery codes enabled",       desc: "Users can generate one-time backup codes as a 2FA fallback." },
            ]).map(({ key, label, desc }) => (
              <div key={key} className="flex items-start justify-between gap-4 py-3 border-b border-gray-800/40 last:border-0">
                <div>
                  <p className="text-sm text-white font-medium">{label}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
                </div>
                <Toggle checked={settings[key] === "true"} onChange={(v) => updateSetting(key, v ? "true" : "false")} disabled={settingsSaving} />
              </div>
            ))}

            <div className="flex items-start justify-between gap-4 py-3">
              <div>
                <p className="text-sm text-white font-medium">Minimum password length</p>
                <p className="text-xs text-gray-500 mt-0.5">Characters required for new passwords.</p>
              </div>
              <input type="number" min={8} max={64} value={settings.min_password_length}
                onChange={(e) => updateSetting("min_password_length", e.target.value)}
                onBlur={(e) => updateSetting("min_password_length", String(Math.max(8, Number(e.target.value))))}
                className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-sm text-white text-center focus:outline-none focus:border-gray-600" />
            </div>
          </div>
        )}
      </SectionCard>

      {/* ── 2: Admin 2FA Status ───────────────────────────────────────────────── */}
      <SectionCard title="Your 2FA Status (SYSTEM_ADMIN)">
        {!adminStatus ? <p className="text-sm text-gray-600">Loading…</p> : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="bg-gray-800/40 rounded-xl p-3 space-y-1">
                <p className="text-xs text-gray-500">TOTP status</p>
                <div className="flex items-center gap-1.5">
                  {adminStatus.totpEnabled
                    ? <><ShieldCheck size={14} className="text-emerald-400" /><span className="text-sm font-semibold text-emerald-400">Enabled</span></>
                    : <><ShieldOff   size={14} className="text-gray-600"    /><span className="text-sm font-semibold text-gray-400">Disabled</span></>}
                </div>
              </div>
              <div className="bg-gray-800/40 rounded-xl p-3 space-y-1">
                <p className="text-xs text-gray-500">Recovery codes</p>
                <p className={`text-sm font-semibold ${adminStatus.recoveryCodesRemaining === 0 ? "text-red-400" : "text-white"}`}>
                  {adminStatus.recoveryCodesRemaining} remaining
                </p>
              </div>
              <div className="bg-gray-800/40 rounded-xl p-3 space-y-1">
                <p className="text-xs text-gray-500">Active sessions</p>
                <p className="text-sm font-semibold text-white">{adminStatus.activeSessions}</p>
              </div>
              <div className="bg-gray-800/40 rounded-xl p-3 space-y-1">
                <p className="text-xs text-gray-500">Last login</p>
                <p className="text-xs text-gray-400">{fmtDateTime(adminStatus.lastLogin)}</p>
                {adminStatus.lastLoginIp && <p className="text-xs text-gray-600 font-mono">{adminStatus.lastLoginIp}</p>}
              </div>
            </div>

            {adminStatus.lastCodeGeneration && (
              <p className="text-xs text-gray-600">Recovery codes last generated: {fmtDateTime(adminStatus.lastCodeGeneration)}</p>
            )}

            <div className="pt-2 border-t border-gray-800/60">
              <Suspense fallback={<div className="h-16 rounded-xl bg-gray-800 animate-pulse" />}>
                <TotpSection />
              </Suspense>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                onClick={() => { if (adminStatus) { setSelectedUser({ id: adminStatus.userId, email: "your account" } as SecurityUser); setModal("recoveryCodes"); } }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-gray-800 border border-gray-700 text-gray-400 hover:text-white transition-colors"
              >
                <Key size={12} /> Regenerate recovery codes
              </button>
            </div>

            {!adminStatus.totpEnabled && (
              <div className="p-3 rounded-xl bg-red-500/5 border border-red-500/20">
                <p className="text-xs text-red-400 font-semibold">Your admin account does not have 2FA enabled.</p>
                <p className="text-xs text-gray-500 mt-0.5">Enable TOTP before requiring it for other users. This account has elevated privileges — secure it with an authenticator app.</p>
              </div>
            )}
          </div>
        )}
      </SectionCard>

      {/* ── 3: Your Active Sessions ───────────────────────────────────────────── */}
      <SectionCard title="Your Active Sessions">
        <SessionsList
          sessions={adminSessions}
          onRevoke={revokeAdminSession}
          onRevokeAll={revokeAllOtherAdminSessions}
          revokeAllLabel="Revoke all other sessions"
        />
      </SectionCard>

      {/* ── 4: User Security Management ──────────────────────────────────────── */}
      <SectionCard title="User Security Management">
        <div className="space-y-4">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input value={userSearch} onChange={(e) => setUserSearch(e.target.value)} placeholder="Search users…"
              className="w-full bg-gray-800/60 border border-gray-700 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-600" />
            {userSearch && (
              <button onClick={() => setUserSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400">
                <X size={14} />
              </button>
            )}
          </div>

          <div className="rounded-xl border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-xs text-gray-500 text-left bg-gray-800/30">
                  <th className="px-4 py-2.5 font-medium">User</th>
                  <th className="px-4 py-2.5 font-medium hidden sm:table-cell">2FA</th>
                  <th className="px-4 py-2.5 font-medium hidden md:table-cell">Sessions</th>
                  <th className="px-4 py-2.5 font-medium hidden lg:table-cell">Last Login</th>
                  <th className="px-4 py-2.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-xs text-gray-600">{userSearch ? "No users match the search." : "No users found."}</td></tr>
                ) : (
                  filteredUsers.map((u, idx) => {
                    const expanded = expandedUser === u.id;
                    return (
                      <React.Fragment key={u.id}>
                        <tr className={`${idx < filteredUsers.length - 1 || expanded ? "border-b border-gray-800/60" : ""} hover:bg-gray-800/20 transition-colors`}>
                          {/* Identity */}
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2.5">
                              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                                u.role === "SYSTEM_ADMIN" ? "bg-red-500/20 border border-red-500/30 text-red-400" : "bg-gray-800 border border-gray-700 text-gray-300"
                              }`}>
                                {((u.firstName ?? u.name ?? u.email)[0]).toUpperCase()}
                              </div>
                              <div>
                                <p className="text-xs font-medium text-white">
                                  {u.firstName && u.lastName ? `${u.firstName} ${u.lastName}` : (u.name ?? u.email)}
                                </p>
                                <p className="text-xs text-gray-500">{u.email}</p>
                                {u.role === "SYSTEM_ADMIN" && <span className="text-xs text-red-400 font-medium">SYSTEM_ADMIN</span>}
                              </div>
                            </div>
                          </td>

                          {/* 2FA */}
                          <td className="px-4 py-3 hidden sm:table-cell">
                            {u.totpEnabled ? (
                              <div>
                                <div className="flex items-center gap-1 text-emerald-400"><ShieldCheck size={12} /><span className="text-xs font-medium">Enabled</span></div>
                                <p className="text-xs text-gray-600">{u.recoveryCodesRemaining} codes left</p>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1 text-gray-600"><ShieldOff size={12} /><span className="text-xs">Disabled</span></div>
                            )}
                          </td>

                          {/* Sessions */}
                          <td className="px-4 py-3 hidden md:table-cell">
                            <button
                              onClick={() => { setSelectedUser(u); setModal("userSessions"); }}
                              className={`text-xs font-medium hover:underline ${u.activeSessionCount > 0 ? "text-blue-400" : "text-gray-600"}`}
                            >
                              {u.activeSessionCount} active
                            </button>
                          </td>

                          {/* Last login */}
                          <td className="px-4 py-3 hidden lg:table-cell text-xs text-gray-500">{fmtDateTime(u.lastLogin)}</td>

                          {/* Actions toggle */}
                          <td className="px-4 py-3">
                            <button
                              onClick={() => setExpandedUser(expanded ? null : u.id)}
                              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-gray-800 border border-gray-700 text-gray-400 hover:text-white transition-colors"
                            >
                              Actions {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                            </button>
                          </td>
                        </tr>

                        {/* Expanded actions */}
                        {expanded && (
                          <tr className="border-b border-gray-800/60 bg-gray-800/20">
                            <td colSpan={5} className="px-4 py-3">
                              <div className="flex flex-wrap gap-2">
                                <button onClick={() => { setSelectedUser(u); setModal("reset2fa"); }}
                                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors">
                                  <RefreshCw size={11} /> Reset 2FA
                                </button>
                                <button onClick={() => { setSelectedUser(u); setModal("recoveryCodes"); }}
                                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors">
                                  <Key size={11} /> Regenerate codes
                                </button>
                                <button onClick={() => { setSelectedUser(u); setModal("userSessions"); }}
                                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-500/10 border border-blue-500/20 text-blue-400 hover:bg-blue-500/20 transition-colors">
                                  <Monitor size={11} /> View sessions ({u.activeSessionCount})
                                </button>
                                <button onClick={() => revokeUserAllSessions(u.id)} disabled={u.activeSessionCount === 0}
                                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-orange-500/10 border border-orange-500/20 text-orange-400 hover:bg-orange-500/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                                  <LogOut size={11} /> Revoke all sessions
                                </button>
                                <button disabled title="Force password reset — coming in production hardening"
                                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-600 cursor-not-allowed">
                                  Force password reset <span className="text-gray-700">(soon)</span>
                                </button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </SectionCard>

      {/* ── Modals ─────────────────────────────────────────────────────────────── */}

      {modal === "reset2fa" && selectedUser && selectedUser.id !== adminStatus?.userId && (
        <ResetTwoFaModal
          user={selectedUser}
          onClose={() => { setModal(null); setSelectedUser(null); }}
          onSuccess={() => { showToast(`2FA reset for ${selectedUser.email}`); fetchUsers(userSearch); setExpandedUser(null); }}
        />
      )}

      {modal === "recoveryCodes" && selectedUser && (
        <RecoveryCodesModal
          userId={selectedUser.id}
          onClose={() => { setModal(null); setSelectedUser(null); fetchAdminStatus(); fetchUsers(userSearch); }}
        />
      )}

      {modal === "userSessions" && selectedUser && (
        <UserSessionsModal
          user={selectedUser}
          onClose={() => { setModal(null); setSelectedUser(null); fetchUsers(userSearch); }}
        />
      )}
    </div>
  );
}
