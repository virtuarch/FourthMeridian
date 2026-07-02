"use client";

/**
 * components/dashboard/TotpSection.tsx
 *
 * Self-contained 2FA management panel shown in the user Settings page.
 * Handles:
 *   - Fetching current TOTP status
 *   - Enable 2FA flow: QR code → verification → recovery codes reveal
 *   - Disable 2FA flow: confirmation modal with TOTP or password
 *   - Recovery code count + regeneration
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  ShieldCheck, ShieldOff, X, Copy, Eye, EyeOff,
  Loader2, CheckCircle2, AlertTriangle, Key, RefreshCw, Lock,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type TotpStatus = {
  totpEnabled:            boolean;
  totpConfigured:         boolean;
  recoveryCodesRemaining: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button onClick={copy} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors">
      {copied ? <CheckCircle2 size={12} className="text-emerald-400" /> : <Copy size={12} />}
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

// ── Setup Modal ───────────────────────────────────────────────────────────────

function SetupModal({ onClose, onEnabled, enforced = false }: { onClose: () => void; onEnabled: () => void; enforced?: boolean }) {
  type ModalStep = "qr" | "codes";

  const [modalStep,   setModalStep]   = useState<ModalStep>("qr");
  const [qrUrl,       setQrUrl]       = useState("");
  const [manualKey,   setManualKey]   = useState("");
  const [showKey,     setShowKey]     = useState(false);
  const [code,        setCode]        = useState("");
  const [codes,       setCodes]       = useState<string[]>([]);
  const [showCodes,   setShowCodes]   = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState("");
  const codeInputRef                  = useRef<HTMLInputElement>(null);

  // Fetch QR code on mount
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res  = await fetch("/api/user/totp/setup", { method: "POST" });
        const data = await res.json();
        if (!res.ok) { setError(data.error ?? "Failed to start setup."); return; }
        setQrUrl(data.qrCodeDataUrl);
        setManualKey(data.manualKey);
      } catch { setError("Network error. Try again."); }
      finally  { setLoading(false); setTimeout(() => codeInputRef.current?.focus(), 100); }
    })();
  }, []);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = code.replace(/\s/g, "");
    if (trimmed.length !== 6) return;

    setLoading(true); setError("");
    try {
      const res  = await fetch("/api/user/totp/verify", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ code: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Verification failed."); return; }
      setCodes(data.recoveryCodes ?? []);
      setModalStep("codes");
    } catch { setError("Network error. Try again."); }
    finally  { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-800">
          <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
            <ShieldCheck size={16} className="text-blue-400" />
          </div>
          <h3 className="text-sm font-semibold text-white">
            {modalStep === "qr" ? "Set up two-factor authentication" : "Save your recovery codes"}
          </h3>
          {modalStep === "codes" && (
            <button onClick={() => { onEnabled(); onClose(); }} className="ml-auto text-gray-600 hover:text-gray-400">
              <X size={16} />
            </button>
          )}
        </div>

        {/* QR step */}
        {modalStep === "qr" && (
          <>
            <div className="px-5 py-5 space-y-5">
              {enforced && (
                <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-500/5 border border-amber-500/20">
                  <Lock size={13} className="text-amber-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs font-semibold text-amber-400">Two-factor authentication is required</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      Your organization requires 2FA. Set it up now to continue using Fourth Meridian.
                    </p>
                  </div>
                </div>
              )}

              {error && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-400">{error}</div>
              )}

              <p className="text-sm text-gray-400">
                Scan this QR code with your authenticator app, then enter the 6-digit code to confirm.
              </p>

              <p className="text-xs text-gray-500">
                Works with: Google Authenticator, Microsoft Authenticator, Authy, 1Password, Bitwarden, iCloud Passwords
              </p>

              {/* QR code */}
              <div className="flex justify-center">
                {loading || !qrUrl ? (
                  <div className="w-[200px] h-[200px] bg-gray-800 rounded-xl flex items-center justify-center">
                    <Loader2 size={24} className="animate-spin text-gray-600" />
                  </div>
                ) : (
                  <img
                    src={qrUrl}
                    alt="TOTP QR code"
                    className="w-[200px] h-[200px] rounded-xl bg-white p-2"
                  />
                )}
              </div>

              {/* Manual key */}
              {manualKey && (
                <div>
                  <button
                    onClick={() => setShowKey((v) => !v)}
                    className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors mb-2"
                  >
                    {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
                    {showKey ? "Hide manual setup key" : "Can't scan? Enter key manually"}
                  </button>
                  {showKey && (
                    <div className="flex items-center gap-2 bg-gray-800/60 rounded-xl px-3 py-2.5">
                      <code className="text-xs text-white font-mono tracking-wider flex-1 break-all">
                        {manualKey}
                      </code>
                      <CopyButton text={manualKey} />
                    </div>
                  )}
                </div>
              )}

              {/* 6-digit verify */}
              <form onSubmit={handleVerify} className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1.5">Enter the 6-digit code from your app</label>
                  <input
                    ref={codeInputRef}
                    type="text"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    placeholder="000000"
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm font-mono tracking-widest text-center placeholder-gray-600 focus:outline-none focus:border-blue-500/50 transition-colors"
                  />
                </div>

                <div className="flex items-center gap-2">
                  {!enforced && (
                    <button
                      type="button"
                      onClick={onClose}
                      className="flex-1 px-4 py-2.5 rounded-xl text-sm text-gray-400 hover:text-white hover:bg-gray-800 border border-gray-800 transition-colors"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={loading || code.length !== 6}
                    className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors flex items-center justify-center gap-2"
                  >
                    {loading ? <><Loader2 size={13} className="animate-spin" /> Verifying…</> : "Verify & Enable"}
                  </button>
                </div>
              </form>
            </div>
          </>
        )}

        {/* Recovery codes step */}
        {modalStep === "codes" && (
          <div className="px-5 py-5 space-y-5">
            <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20 flex items-start gap-2">
              <CheckCircle2 size={14} className="text-emerald-400 mt-0.5 shrink-0" />
              <p className="text-xs text-emerald-400 font-medium">Two-factor authentication is now enabled.</p>
            </div>

            <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/20">
              <p className="text-xs font-semibold text-amber-400">Save these recovery codes now.</p>
              <p className="text-xs text-gray-400 mt-1">
                They won&apos;t be shown again. Each code can only be used once to access your account
                if you lose your authenticator device.
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">{codes.length} recovery codes</span>
                <div className="flex items-center gap-3">
                  <button onClick={() => setShowCodes((v) => !v)} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors">
                    {showCodes ? <EyeOff size={12} /> : <Eye size={12} />}
                    {showCodes ? "Hide" : "Show"}
                  </button>
                  <CopyButton text={codes.join("\n")} />
                </div>
              </div>

              <div className="bg-gray-800/60 rounded-xl p-3 font-mono text-sm space-y-1">
                {codes.map((c, i) => (
                  <p key={i} className={showCodes ? "text-white tabular-nums" : "text-gray-800 select-none"}>
                    {showCodes ? c : "••••••••-••••••••"}
                  </p>
                ))}
              </div>
            </div>

            <button
              onClick={() => { onEnabled(); onClose(); }}
              className="w-full px-4 py-2.5 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              I&apos;ve saved my recovery codes
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Regenerate Modal ──────────────────────────────────────────────────────────

function RegenerateModal({ onClose, onRegenerated }: { onClose: () => void; onRegenerated: () => void }) {
  const [totpCode,  setTotpCode]  = useState("");
  const [codes,     setCodes]     = useState<string[]>([]);
  const [showCodes, setShowCodes] = useState(false);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState("");
  const [done,      setDone]      = useState(false);

  async function handleRegenerate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError("");

    try {
      const res  = await fetch("/api/user/totp/recovery-codes", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ totpCode: totpCode.replace(/\s/g, "") }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed."); return; }
      setCodes(data.recoveryCodes ?? []);
      setDone(true);
      onRegenerated();
    } catch { setError("Network error."); }
    finally  { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-800">
          <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <RefreshCw size={15} className="text-amber-400" />
          </div>
          <h3 className="text-sm font-semibold text-white">Regenerate recovery codes</h3>
          {done && <button onClick={onClose} className="ml-auto text-gray-600 hover:text-gray-400"><X size={16} /></button>}
        </div>

        <div className="px-5 py-5 space-y-4">
          {!done ? (
            <>
              <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/20 text-xs text-gray-400">
                This will <span className="text-amber-400 font-medium">invalidate all existing recovery codes</span> and
                generate 10 new ones. Confirm with your authenticator app.
              </div>

              {error && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-400">{error}</div>
              )}

              <form onSubmit={handleRegenerate} className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1.5">Authenticator code</label>
                  <input
                    type="text" inputMode="numeric" maxLength={6} autoFocus
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
                    placeholder="000000"
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm font-mono tracking-widest text-center placeholder-gray-600 focus:outline-none focus:border-amber-500/40 transition-colors"
                  />
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={onClose}
                    className="flex-1 px-4 py-2.5 rounded-xl text-sm text-gray-400 hover:text-white hover:bg-gray-800 border border-gray-800 transition-colors">
                    Cancel
                  </button>
                  <button type="submit" disabled={loading || totpCode.length !== 6}
                    className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2">
                    {loading ? <><Loader2 size={13} className="animate-spin" /> Regenerating…</> : "Regenerate codes"}
                  </button>
                </div>
              </form>
            </>
          ) : (
            <>
              <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20 flex items-start gap-2">
                <CheckCircle2 size={14} className="text-emerald-400 mt-0.5 shrink-0" />
                <p className="text-xs text-emerald-400 font-medium">New recovery codes generated. Your old codes are now invalid.</p>
              </div>

              <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/20 text-xs text-gray-400">
                Save these now — they won&apos;t be shown again. Each can only be used once.
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">{codes.length} recovery codes</span>
                  <div className="flex items-center gap-3">
                    <button onClick={() => setShowCodes((v) => !v)} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors">
                      {showCodes ? <EyeOff size={12} /> : <Eye size={12} />}
                      {showCodes ? "Hide" : "Show"}
                    </button>
                    <CopyButton text={codes.join("\n")} />
                  </div>
                </div>
                <div className="bg-gray-800/60 rounded-xl p-3 font-mono text-sm space-y-1">
                  {codes.map((c, i) => (
                    <p key={i} className={showCodes ? "text-white tabular-nums" : "text-gray-800 select-none"}>
                      {showCodes ? c : "••••••••-••••••••"}
                    </p>
                  ))}
                </div>
              </div>

              <button onClick={onClose}
                className="w-full px-4 py-2.5 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors">
                I&apos;ve saved my recovery codes
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Disable Modal ─────────────────────────────────────────────────────────────

function DisableModal({ onClose, onDisabled }: { onClose: () => void; onDisabled: () => void }) {
  const [useTotp,   setUseTotp]   = useState(true);
  const [totpCode,  setTotpCode]  = useState("");
  const [password,  setPassword]  = useState("");
  const [showPw,    setShowPw]    = useState(false);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState("");

  async function handleDisable(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError("");

    const body = useTotp
      ? { totpCode: totpCode.replace(/\s/g, "") }
      : { password };

    try {
      const res  = await fetch("/api/user/totp/disable", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed."); return; }
      onDisabled(); onClose();
    } catch { setError("Network error."); }
    finally  { setLoading(false); }
  }

  const canSubmit = useTotp ? totpCode.replace(/\s/g, "").length === 6 : password.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md bg-gray-900 border border-red-900/40 rounded-2xl shadow-2xl">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-800">
          <AlertTriangle size={16} className="text-red-400" />
          <h3 className="text-sm font-semibold text-white">Disable two-factor authentication</h3>
          <button onClick={onClose} className="ml-auto text-gray-600 hover:text-gray-400"><X size={16} /></button>
        </div>

        <div className="px-5 py-5 space-y-4">
          <div className="p-3 rounded-xl bg-red-500/5 border border-red-500/20 text-xs text-gray-400">
            Disabling 2FA removes the extra layer of protection from your account and deletes all recovery codes.
          </div>

          {/* Toggle: TOTP vs password */}
          <div className="flex rounded-xl overflow-hidden border border-gray-800">
            <button onClick={() => setUseTotp(true)}  className={`flex-1 py-2 text-xs font-medium transition-colors ${useTotp  ? "bg-gray-800 text-white" : "text-gray-500 hover:text-gray-300"}`}>Authenticator code</button>
            <button onClick={() => setUseTotp(false)} className={`flex-1 py-2 text-xs font-medium transition-colors ${!useTotp ? "bg-gray-800 text-white" : "text-gray-500 hover:text-gray-300"}`}>Account password</button>
          </div>

          {error && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-400">{error}</div>
          )}

          <form onSubmit={handleDisable} className="space-y-3">
            {useTotp ? (
              <div>
                <label className="block text-xs text-gray-500 mb-1.5">Current TOTP code</label>
                <input
                  type="text" inputMode="numeric" maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
                  autoFocus placeholder="000000"
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm font-mono tracking-widest text-center placeholder-gray-600 focus:outline-none focus:border-red-500/40 transition-colors"
                />
              </div>
            ) : (
              <div>
                <label className="block text-xs text-gray-500 mb-1.5">Current password</label>
                <div className="relative">
                  <input
                    type={showPw ? "text" : "password"}
                    value={password} onChange={(e) => setPassword(e.target.value)}
                    autoFocus placeholder="••••••••"
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 pr-11 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-red-500/40 transition-colors"
                  />
                  <button type="button" onClick={() => setShowPw((v) => !v)} tabIndex={-1}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 p-1">
                    {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button type="button" onClick={onClose}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm text-gray-400 hover:text-white hover:bg-gray-800 border border-gray-800 transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={loading || !canSubmit}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2">
                {loading ? <><Loader2 size={13} className="animate-spin" /> Disabling…</> : "Disable 2FA"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ── Main TotpSection ──────────────────────────────────────────────────────────

export function TotpSection() {
  const { update: updateSession } = useSession();
  const searchParams = useSearchParams();
  const enforced     = searchParams.get("setup2fa") === "true";

  const [status,  setStatus]  = useState<TotpStatus | null>(null);
  const [modal,   setModal]   = useState<"setup" | "disable" | "regenerate" | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    const res  = await fetch("/api/user/totp/status");
    const data = await res.json();
    setStatus(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => fetchStatus(), 0);
    return () => clearTimeout(t);
  }, [fetchStatus]);

  // Auto-open setup modal when redirected here due to platform enforcement
  useEffect(() => {
    if (!enforced || loading || status?.totpEnabled) return;
    const t = setTimeout(() => setModal("setup"), 0);
    return () => clearTimeout(t);
  }, [enforced, loading, status?.totpEnabled]);

  async function handleEnrolled() {
    fetchStatus();
    // Clear requireTotpSetup from the JWT so middleware stops redirecting
    await updateSession({ requireTotpSetup: false });
    // Remove the query param from the URL without a page reload
    const url = new URL(window.location.href);
    url.searchParams.delete("setup2fa");
    window.history.replaceState({}, "", url.toString());
  }

  return (
    <div className="space-y-4">
      {/* Enforcement banner — shown when redirected here by the platform requirement */}
      {enforced && !status?.totpEnabled && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-500/5 border border-amber-500/20">
          <Lock size={13} className="text-amber-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-xs font-semibold text-amber-400">Two-factor authentication required</p>
            <p className="text-xs text-gray-400 mt-0.5">
              Your account requires 2FA before you can access Fourth Meridian. Click &quot;Enable 2FA&quot; to set it up.
            </p>
          </div>
        </div>
      )}

      {/* Status row */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          {loading ? (
            <div className="w-8 h-8 rounded-lg bg-gray-800 animate-pulse" />
          ) : status?.totpEnabled ? (
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
              <ShieldCheck size={16} className="text-emerald-400" />
            </div>
          ) : (
            <div className="w-8 h-8 rounded-lg bg-gray-800 border border-gray-700 flex items-center justify-center">
              <ShieldOff size={16} className="text-gray-500" />
            </div>
          )}
          <div>
            <p className="text-sm font-medium text-white">
              {status?.totpEnabled ? "Two-factor authentication is on" : "Two-factor authentication is off"}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              {status?.totpEnabled
                ? `${status.recoveryCodesRemaining} recovery code${status.recoveryCodesRemaining !== 1 ? "s" : ""} remaining`
                : "Add an extra layer of security to your account."}
            </p>
          </div>
        </div>

        {!loading && (
          status?.totpEnabled ? (
            <button
              onClick={() => setModal("disable")}
              className="shrink-0 px-3 py-1.5 rounded-xl text-xs font-medium bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors"
            >
              Disable
            </button>
          ) : (
            <button
              onClick={() => setModal("setup")}
              className="shrink-0 px-3 py-1.5 rounded-xl text-xs font-medium bg-blue-500/10 border border-blue-500/20 text-blue-400 hover:bg-blue-500/20 transition-colors"
            >
              Enable 2FA
            </button>
          )
        )}
      </div>

      {/* Recovery codes warning */}
      {status?.totpEnabled && status.recoveryCodesRemaining <= 2 && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-500/5 border border-amber-500/20">
          <AlertTriangle size={13} className="text-amber-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-xs font-medium text-amber-400">
              {status.recoveryCodesRemaining === 0
                ? "You have no recovery codes left."
                : `Only ${status.recoveryCodesRemaining} recovery code${status.recoveryCodesRemaining !== 1 ? "s" : ""} remaining.`}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              Go to Admin → Security to regenerate your recovery codes.
            </p>
          </div>
        </div>
      )}

      {/* Supported apps note */}
      {!status?.totpEnabled && !loading && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-gray-800/40 border border-gray-800">
          <Key size={13} className="text-gray-500 mt-0.5 shrink-0" />
          <p className="text-xs text-gray-500">
            Works with Google Authenticator, Microsoft Authenticator, Authy, 1Password, Bitwarden, and iCloud Passwords.
          </p>
        </div>
      )}

      {/* Regenerate recovery codes */}
      {status?.totpEnabled && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <RefreshCw size={11} className="text-gray-600" />
            <p className="text-xs text-gray-600">Lost your recovery codes?</p>
          </div>
          <button
            onClick={() => setModal("regenerate")}
            className="text-xs text-gray-500 hover:text-gray-300 underline underline-offset-2 transition-colors"
          >
            Regenerate codes
          </button>
        </div>
      )}

      {/* Modals */}
      {modal === "setup" && (
        <SetupModal
          onClose={() => { if (!enforced) setModal(null); }}
          onEnabled={() => { setModal(null); handleEnrolled(); }}
          enforced={enforced}
        />
      )}

      {modal === "disable" && (
        <DisableModal
          onClose={() => setModal(null)}
          onDisabled={() => { setModal(null); fetchStatus(); }}
        />
      )}

      {modal === "regenerate" && (
        <RegenerateModal
          onClose={() => setModal(null)}
          onRegenerated={() => fetchStatus()}
        />
      )}
    </div>
  );
}
