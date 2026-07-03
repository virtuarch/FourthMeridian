"use client";

/**
 * components/admin/AdminExpandHistoryFlow.tsx
 *
 * Modal flow that guides the admin through relinking an institution to retrieve
 * up to 730 days of additional transaction history.
 *
 * High-level sequence:
 *   1. Mounts in "confirming" state — shows a confirmation view with the
 *      institution name, what will happen, what is preserved, and a note
 *      that Plaid's generic institution search must be used.
 *   2. "Continue to Plaid" → link token fetched from expand-history-token.
 *   3. Plaid Link opens. Admin searches for and relinks the institution.
 *   4. onSuccess → POST /api/admin/plaid/exchange-expanded-history-token
 *      This single endpoint handles:
 *        a. Deriving the institution owner's userId from oldPlaidItemId
 *        b. Resolving the owner's Personal Space (not the admin's)
 *        c. Exchanging the public_token and importing accounts/transactions
 *        d. Retiring the old PlaidItem (soft-delete connections + itemRemove)
 *   5. Done → shows confirmation; calls onDone() to trigger a page refresh.
 *
 * WHY A DEDICATED ADMIN EXCHANGE ENDPOINT:
 *   The normal /api/plaid/exchange-token calls getSpaceContext(), which reads
 *   the session user's ID (the admin). Accounts would be created with the
 *   admin's userId, fingerprint matching would miss the real owner's accounts,
 *   SpaceAccountLinks would go to the admin's Space, and retire would fail
 *   (it queries by userId of the old item). exchange-expanded-history-token
 *   resolves userId + spaceId from the old PlaidItem instead.
 *
 * State machine (phase):
 *   confirming     — confirmation view (Cancel / Continue to Plaid)
 *   fetching_token — fetching fresh link token
 *   awaiting_link  — Plaid Link is open (modal behind Plaid UI)
 *   importing      — exchange-expanded-history-token running (exchange + retire)
 *   done           — success
 *   error          — any step failed
 *
 * Token fetch is deferred until the admin clicks Continue (fetchTrigger > 0).
 *
 * Async setState rules:
 *   • Token fetch effect: gated on fetchTrigger > 0; all setState in .then/.catch.
 *   • Auto-open effect: calls open() only — no setState.
 *   • onPlaidSuccess / onPlaidExit: called by Plaid (not in effects) — setState safe.
 *   • lastProgressPhase: state (not ref) so it can be read during render.
 *
 * SECURITY NOTE — userId scope:
 *   exchange-expanded-history-token derives userId from the oldPlaidItem row
 *   and never uses the admin's session userId for account writes. This ensures
 *   accounts are owned by the institution owner, not the admin.
 */

import { useEffect, useRef, useState } from "react";
import { usePlaidLink, PlaidLinkOnSuccess, PlaidLinkOnExit } from "react-plaid-link";
import { CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { Dialog } from "@/components/atlas/Dialog";

// ── Phase type ────────────────────────────────────────────────────────────────

type Phase =
  | "confirming"
  | "fetching_token"
  | "awaiting_link"
  | "importing"
  | "done"
  | "error";

const PROGRESS_PHASES: Phase[] = ["fetching_token", "awaiting_link", "importing", "done"];

const STEP_LABELS: Record<Phase, string> = {
  confirming:     "",
  fetching_token: "Generating secure token",
  awaiting_link:  "Plaid Link reauthorization",
  importing:      "Import accounts, transactions & retire",
  done:           "Complete",
  error:          "",
};

const PROGRESS_STATUS: Record<Phase, string> = {
  confirming:     "",
  fetching_token: "Preparing secure relink…",
  awaiting_link:  "Opening Plaid Link…",
  importing:      "Importing and retiring previous connection…",
  done:           "History expansion complete",
  error:          "Something went wrong",
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  plaidItemId:     string;
  institutionName: string;
  onClose:         () => void;
  onDone:          () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AdminExpandHistoryFlow({
  plaidItemId,
  institutionName,
  onClose,
  onDone,
}: Props) {
  const [phase,             setPhase]             = useState<Phase>("confirming");
  const [linkToken,         setLinkToken]         = useState<string | null>(null);
  const [error,             setError]             = useState<string | null>(null);
  const [fetchTrigger,      setFetchTrigger]      = useState(0);
  // Tracks the last progress phase reached so completed steps stay marked done
  // in the error state. Must be state (not ref) — refs cannot be read during render.
  const [lastProgressPhase, setLastProgressPhase] = useState<Phase | null>(null);

  const oldPlaidItemIdRef = useRef(plaidItemId);
  const hasOpened         = useRef(false);

  // ── Token fetch (deferred until Continue click) ───────────────────────────
  useEffect(() => {
    if (fetchTrigger === 0) return;
    let alive = true;

    fetch("/api/admin/plaid/expand-history-token", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ plaidItemId }),
    })
      .then((res) => {
        if (!res.ok) {
          return res
            .json()
            .catch(() => ({}))
            .then((d: { error?: string }) =>
              Promise.reject(new Error(d.error ?? `HTTP ${res.status}`)),
            );
        }
        return res.json() as Promise<{
          link_token: string; oldPlaidItemId: string; institutionName: string;
        }>;
      })
      .then((data) => {
        if (!alive) return;
        oldPlaidItemIdRef.current = data.oldPlaidItemId;
        setLinkToken(data.link_token);
        setPhase("awaiting_link");
        setLastProgressPhase("awaiting_link");
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Failed to start Expand History. Please try again.");
        setPhase("error");
      });

    return () => { alive = false; };
  }, [plaidItemId, fetchTrigger]);

  // ── Continue button ───────────────────────────────────────────────────────
  function handleContinue() {
    setPhase("fetching_token");
    setLastProgressPhase("fetching_token");
    setFetchTrigger((t) => t + 1);
  }

  // ── Plaid success ─────────────────────────────────────────────────────────
  const onPlaidSuccess: PlaidLinkOnSuccess = async (public_token) => {
    setPhase("importing");
    setLastProgressPhase("importing");

    try {
      const res = await fetch("/api/admin/plaid/exchange-expanded-history-token", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          publicToken:    public_token,
          oldPlaidItemId: oldPlaidItemIdRef.current,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? `exchange failed (HTTP ${res.status})`);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Import failed. Please try again.");
      setPhase("error");
      return;
    }

    setPhase("done");
    setLastProgressPhase("done");
    onDone();
  };

  // ── Plaid exit ────────────────────────────────────────────────────────────
  const onPlaidExit: PlaidLinkOnExit = (plaidErr) => {
    if (plaidErr) {
      setError(
        plaidErr.display_message ??
          plaidErr.error_message ??
          "Plaid Link exited with an error. Please try again.",
      );
      setPhase("error");
    } else {
      onClose();
    }
  };

  // ── usePlaidLink (always called — rules of hooks) ─────────────────────────
  const { open, ready } = usePlaidLink({
    token:     linkToken ?? "",
    onSuccess: onPlaidSuccess,
    onExit:    onPlaidExit,
  });

  // ── Auto-open once ready ──────────────────────────────────────────────────
  useEffect(() => {
    if (ready && linkToken && phase === "awaiting_link" && !hasOpened.current) {
      hasOpened.current = true;
      open();
    }
  }, [ready, linkToken, phase, open]);

  // ── Render helpers ────────────────────────────────────────────────────────

  const isConfirming = phase === "confirming";
  const isDone       = phase === "done";
  const isError      = phase === "error";

  const effectivePhase = isError
    ? (lastProgressPhase ?? "fetching_token")
    : phase;
  const currentStepIdx = PROGRESS_PHASES.indexOf(effectivePhase);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Dialog
      open
      onClose={onClose}
      title="Expand Transaction History"
      hideHeader
      size="sm"
      preventClose
      closeOnBackdrop={false}
    >

        {/* ── Confirmation view ── */}
        {isConfirming && (
          <div className="space-y-4">
            {/* Header */}
            <div>
              <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide font-medium">
                Expand Transaction History
              </p>
              <p className="text-lg font-semibold text-white mt-0.5">{institutionName}</p>
            </div>

            {/* Main message */}
            <div>
              <p className="text-sm text-[var(--text-secondary)]">
                Reconnect {institutionName} to import additional historical transactions.
              </p>
              <p className="text-sm font-semibold text-[var(--accent-info)] mt-1">
                Up to 730 days of history
              </p>
            </div>

            {/* Preservation checklist */}
            <div>
              <p className="text-xs font-medium text-[var(--text-muted)] mb-2">What is preserved</p>
              <ul className="space-y-1.5">
                {[
                  "Accounts matched and preserved",
                  "Spaces and SpaceAccountLinks preserved",
                  "Debt profiles preserved",
                  "Existing transactions deduplicated",
                  "Old connection retired after successful sync",
                ].map((item) => (
                  <li key={item} className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                    <CheckCircle2 size={11} className="shrink-0 text-[var(--accent-positive)]" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            {/* Plaid search callout */}
            <p className="text-xs text-[var(--text-muted)] border-l-2 border-[var(--border-hairline-strong)] pl-3 leading-relaxed">
              Plaid will open its standard institution search.{" "}
              Search for: <span className="text-[var(--text-secondary)] font-medium">{institutionName.toUpperCase()}</span>
            </p>

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              <button
                onClick={onClose}
                className="flex-1 text-sm font-medium px-4 py-2 rounded-lg bg-[var(--surface-inset)] hover:bg-[var(--surface-hover)] text-[var(--text-secondary)] border border-[var(--border-hairline-strong)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleContinue}
                className="flex-1 text-sm font-medium px-4 py-2 rounded-lg bg-[var(--accent-info)] text-white transition-colors"
              >
                Continue to Plaid
              </button>
            </div>
          </div>
        )}

        {/* ── Progress view ── */}
        {!isConfirming && (
          <div className="space-y-4">
            {/* Compact header */}
            <div>
              <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide font-medium">
                Expand Transaction History
              </p>
              <p className="text-base font-semibold text-white mt-0.5">{institutionName}</p>
            </div>

            {/* Status banner */}
            <div
              className={`flex items-start gap-3 rounded-xl px-4 py-3 border ${
                isError
                  ? "bg-red-500/10 border-red-500/20"
                  : isDone
                    ? "bg-emerald-500/10 border-emerald-500/20"
                    : "bg-[var(--surface-inset)] border-[var(--border-hairline)]"
              }`}
            >
              {isError ? (
                <AlertCircle size={14} className="shrink-0 mt-0.5 text-[var(--accent-negative)]" />
              ) : isDone ? (
                <CheckCircle2 size={14} className="shrink-0 mt-0.5 text-[var(--accent-positive)]" />
              ) : (
                <Loader2 size={14} className="shrink-0 mt-0.5 text-[var(--text-secondary)] animate-spin" />
              )}
              <div className="space-y-1 min-w-0">
                <p
                  className={`text-sm font-medium ${
                    isError ? "text-[var(--accent-negative)]" : isDone ? "text-[var(--accent-positive)]" : "text-[var(--text-primary)]"
                  }`}
                >
                  {PROGRESS_STATUS[phase]}
                </p>
                {isError && error && (
                  <p className="text-xs text-[var(--accent-negative)] leading-relaxed">{error}</p>
                )}
                {isDone && (
                  <p className="text-xs text-[var(--accent-positive)]">
                    Refresh diagnostics to compare before/after transaction coverage.
                  </p>
                )}
              </div>
            </div>

            {/* Steps checklist */}
            <ol className="space-y-2">
              {PROGRESS_PHASES.map((stepPhase, stepIdx) => {
                const isStepDone   = stepIdx < currentStepIdx || phase === "done";
                const isStepActive = stepPhase === phase && !isDone && !isError;
                return (
                  <li key={stepPhase} className="flex items-center gap-2.5 text-xs">
                    <span
                      className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 border text-[9px] font-bold ${
                        isStepDone
                          ? "bg-emerald-500/20 border-emerald-500/40 text-[var(--accent-positive)]"
                          : isStepActive
                            ? "bg-blue-500/20 border-blue-500/40 text-[var(--accent-info)]"
                            : "bg-[var(--surface-inset)] border-[var(--border-hairline-strong)] text-[var(--text-faint)]"
                      }`}
                    >
                      {isStepDone ? "✓" : stepIdx + 1}
                    </span>
                    <span
                      className={
                        isStepDone ? "text-[var(--text-secondary)]" : isStepActive ? "text-[var(--text-primary)]" : "text-[var(--text-faint)]"
                      }
                    >
                      {STEP_LABELS[stepPhase]}
                    </span>
                  </li>
                );
              })}
            </ol>

            {/* Footer action */}
            {(isDone || isError) && (
              <button
                onClick={onClose}
                className={`w-full text-sm font-medium px-4 py-2 rounded-lg transition-colors ${
                  isDone
                    ? "bg-[var(--accent-positive)] text-white"
                    : "bg-[var(--surface-inset)] hover:bg-[var(--surface-hover)] text-[var(--text-primary)] border border-[var(--border-hairline-strong)]"
                }`}
              >
                {isDone ? "Close" : "Dismiss"}
              </button>
            )}
          </div>
        )}
    </Dialog>
  );
}
