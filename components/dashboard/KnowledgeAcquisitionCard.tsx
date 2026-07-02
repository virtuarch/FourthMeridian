"use client";

/**
 * components/dashboard/KnowledgeAcquisitionCard.tsx
 *
 * Knowledge Acquisition — Slice 2 (Persistence).
 *
 * Renders a structured input card beneath an AI chat message when the
 * assembled context contains knowledge gaps (debt metadata fields that are
 * null for FULL-visibility debt accounts).
 *
 * Save calls PATCH /api/accounts/[id]/debt-profile for each account that
 * has filled gaps. The endpoint handles validation, upsert, and audit log.
 * Authorization is enforced by the endpoint (ownerUserId check).
 *
 * Slice 3 addition:
 *   onSaved? callback — called after all PATCHes succeed so the parent
 *   (AnalyzeClient) can inject a follow-up user message and re-send to the
 *   chat API. buildContext() runs fresh on every /api/ai/chat request, so
 *   the AI's next reply automatically sees the newly persisted DebtProfile.
 *
 * The `GapEntry` type mirrors KnowledgeGap from lib/ai/types — defined locally
 * here so this client component does not touch the server-only AI barrel.
 */

import { useState } from "react";
import { PenLine, CheckCircle, Info } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Client-side mirror of KnowledgeGap from lib/ai/types.
 * Received from /api/ai/chat as plain JSON — no server-only imports needed.
 */
export interface GapEntry {
  accountId:    string;
  accountName:  string;
  field:        "apr" | "minimumPayment";
  label:        string;
  debtSubtype?: string | null;
}

// ── Field configuration ───────────────────────────────────────────────────────

interface FieldConfig {
  placeholder: string;
  prefix?:     string;
  suffix?:     string;
  step:        string;
  min:         string;
  max?:        string;
}

const FIELD_CONFIG: Record<GapEntry["field"], FieldConfig> = {
  apr: {
    placeholder: "24.99",
    suffix:      "%",
    step:        "0.01",
    min:         "0",
    max:         "100",
  },
  minimumPayment: {
    placeholder: "25.00",
    prefix:      "$",
    step:        "0.01",
    min:         "0",
  },
};

// ── Clarification card ────────────────────────────────────────────────────────

/**
 * Lightweight inline prompt shown before the full KnowledgeAcquisitionCard.
 * Prefers a one-line "I'm missing X for Y. Want to update it?" pattern.
 * Clicking "Update" expands to the full form; "Not now" snoozes for the session.
 */
interface ClarificationProps {
  gaps:     GapEntry[];
  /** Expand to full KnowledgeAcquisitionCard. */
  onExpand: () => void;
  /** Snooze this gap for the current chat session. */
  onSnooze: () => void;
}

export function KnowledgeClarificationCard({ gaps, onExpand, onSnooze }: ClarificationProps) {
  const accountNames = [...new Set(gaps.map((g) => g.accountName))].join(", ");
  const allSameField = gaps.length > 0 && gaps.every((g) => g.field === gaps[0].field);
  const fieldLabel   = allSameField ? gaps[0].label : "missing information";
  const updateLabel  = allSameField ? `Update ${gaps[0].label}` : "Update";

  return (
    <div className="border border-gray-700/60 bg-gray-800/30 rounded-xl px-3 py-2.5 flex items-start justify-between gap-3">
      <div className="flex items-start gap-2 min-w-0">
        <Info size={13} className="text-blue-400/70 mt-0.5 shrink-0" />
        <p className="text-xs text-gray-400 leading-relaxed">
          <span className="text-gray-200 font-medium">{fieldLabel}</span>
          {" missing for "}
          <span className="text-white">{accountNames}</span>
          {" — adding it improves accuracy."}
        </p>
      </div>
      <div className="flex gap-1.5 shrink-0 mt-0.5">
        <button
          onClick={onExpand}
          className="text-xs text-blue-400 border border-blue-500/40 bg-blue-500/10 px-2.5 py-1 rounded-lg hover:bg-blue-500/20 transition-colors whitespace-nowrap"
        >
          {updateLabel}
        </button>
        <button
          onClick={onSnooze}
          className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1 rounded-lg hover:bg-gray-700/50 transition-colors whitespace-nowrap"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

// ── Save state ────────────────────────────────────────────────────────────────

type SaveState = "idle" | "saving" | "saved" | "error";

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  gaps:       GapEntry[];
  /** Called after all PATCH requests succeed. Parent uses this to inject a
   *  follow-up user message so the AI recalculates with fresh context. */
  onSaved?:   () => void;
  /** Called when the user clicks "Not now". Parent handles session snooze state. */
  onDismiss?: () => void;
}

export function KnowledgeAcquisitionCard({ gaps, onSaved, onDismiss }: Props) {
  // Input values keyed by `${accountId}:${field}`
  const [values, setValues] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Group gaps by account for display and for batching PATCH calls
  const accountOrder: string[] = [];
  const byAccount: Record<string, { name: string; gaps: GapEntry[] }> = {};
  for (const gap of gaps) {
    if (!byAccount[gap.accountId]) {
      byAccount[gap.accountId] = { name: gap.accountName, gaps: [] };
      accountOrder.push(gap.accountId);
    }
    byAccount[gap.accountId].gaps.push(gap);
  }

  // Save enabled when every input has a valid non-negative number and not already saving/saved
  const allFilled = gaps.every((g) => {
    const raw = values[`${g.accountId}:${g.field}`]?.trim();
    return raw !== undefined && raw !== "" && !isNaN(Number(raw)) && Number(raw) >= 0;
  });
  const isBusy = saveState === "saving";
  const canSave = allFilled && saveState !== "saving" && saveState !== "saved";

  function handleChange(key: string, value: string) {
    // Reset error state when user edits after an error so they can retry
    if (saveState === "error") {
      setSaveState("idle");
      setErrorMsg(null);
    }
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    if (!canSave) return;
    setSaveState("saving");
    setErrorMsg(null);

    // One PATCH per account — only include the fields that are in this card's gaps
    const results = await Promise.allSettled(
      accountOrder.map(async (accountId) => {
        const accountGaps = byAccount[accountId].gaps;
        const body: Record<string, number> = {};
        for (const gap of accountGaps) {
          const raw = values[`${accountId}:${gap.field}`]?.trim();
          if (raw !== undefined && raw !== "") {
            body[gap.field] = Number(raw);
          }
        }
        const res = await fetch(`/api/accounts/${accountId}/debt-profile`, {
          method:  "PATCH",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error ?? "Save failed");
        }
      }),
    );

    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    if (failed.length > 0) {
      const first = failed[0].reason as Error;
      setErrorMsg(first.message ?? "Something went wrong. Please try again.");
      setSaveState("error");
    } else {
      setSaveState("saved");
      // Notify parent so it can trigger a follow-up AI request with fresh context.
      // Deferred to next tick so the "✓ Saved" state renders before the chat
      // loading indicator appears.
      setTimeout(() => onSaved?.(), 0);
    }
  }

  return (
    <div className="border border-gray-700 bg-gray-800/50 rounded-xl p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="w-5 h-5 rounded bg-blue-500/20 flex items-center justify-center shrink-0">
          <PenLine size={11} className="text-blue-400" />
        </div>
        <span className="text-xs font-semibold text-gray-300">
          Complete Missing Information
        </span>
      </div>

      {/* Accounts */}
      {accountOrder.map((accountId) => {
        const { name, gaps: accountGaps } = byAccount[accountId];
        return (
          <div key={accountId} className="space-y-2.5">
            <p className="text-xs font-semibold text-white">{name}</p>

            {accountGaps.map((gap) => {
              const key = `${accountId}:${gap.field}`;
              const cfg = FIELD_CONFIG[gap.field];
              return (
                <div key={gap.field} className="space-y-1">
                  <label className="block text-xs text-gray-400">{gap.label}</label>
                  <div className="flex items-center gap-1.5">
                    {cfg.prefix && (
                      <span className="text-xs text-gray-500 select-none">{cfg.prefix}</span>
                    )}
                    <input
                      type="number"
                      inputMode="decimal"
                      placeholder={cfg.placeholder}
                      step={cfg.step}
                      min={cfg.min}
                      {...(cfg.max !== undefined ? { max: cfg.max } : {})}
                      value={values[key] ?? ""}
                      onChange={(e) => handleChange(key, e.target.value)}
                      disabled={isBusy || saveState === "saved"}
                      className="w-28 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    {cfg.suffix && (
                      <span className="text-xs text-gray-500 select-none">{cfg.suffix}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      {/* Inline error */}
      {saveState === "error" && errorMsg && (
        <p className="text-xs text-red-400">{errorMsg}</p>
      )}

      {/* Save / Saved / Not now */}
      {saveState === "saved" ? (
        <div className="flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-green-400">
          <CheckCircle size={13} />
          Saved
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            disabled={!canSave}
            onClick={() => { void handleSave(); }}
            className="flex-1 py-2 rounded-lg text-xs font-medium transition-colors bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white"
          >
            {saveState === "saving" ? "Saving…" : "Save"}
          </button>
          {onDismiss && (
            <button
              onClick={onDismiss}
              disabled={isBusy}
              className="py-2 px-3 rounded-lg text-xs font-medium text-gray-500 hover:text-gray-300 hover:bg-gray-700/50 transition-colors disabled:opacity-40"
            >
              Not now
            </button>
          )}
        </div>
      )}
    </div>
  );
}
