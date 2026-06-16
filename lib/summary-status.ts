/**
 * lib/summary-status.ts
 *
 * Deterministic short status-message helpers for the Cash on Hand and Debt
 * summary cards (Banking page). These are plain threshold rules over
 * already-computed totals — no AI/LLM involved, no invented data.
 *
 * They replace the old colored "pill" badges (e.g. "CLEAR DEBT", "DEPLOY
 * CAPITAL") which read as advice/action prompts. The output here is a short
 * factual status line instead (e.g. "Cash is tight", "Moderate debt load").
 *
 * v2.2 may eventually layer an LLM-rendered insight on top of these facts,
 * but per project rules that is out of scope here — this stays deterministic.
 */

export interface StatusMessage {
  message:   string;
  className: string; // Tailwind text color class
}

/** bankCash = checking + savings balances only (excludes brokerage/crypto cash). */
export function getCashStatusMessage(bankCash: number): StatusMessage {
  if (bankCash >= 1500) return { message: "Healthy cash buffer", className: "text-emerald-400" };
  if (bankCash >= 1000) return { message: "Cash available",      className: "text-blue-400"    };
  return                 { message: "Cash is tight",              className: "text-red-400"     };
}

/** total = sum of debt-account balances (positive = owed). Pass Math.max(0, total). */
export function getDebtStatusMessage(total: number): StatusMessage {
  if (total <= 0)    return { message: "No debt detected",   className: "text-emerald-400" };
  if (total < 5000)  return { message: "Debt under control", className: "text-blue-400"    };
  if (total < 15000) return { message: "Moderate debt load", className: "text-yellow-400"  };
  return                { message: "High debt load",          className: "text-red-400"     };
}
