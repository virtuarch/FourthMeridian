/**
 * lib/imports/investments/profiles.ts
 *
 * A7-3 — built-in broker profiles as DATA (investigation §3.2). A profile is a
 * column-alias set + an action→canonical-rule table + a version; adding a broker
 * is a new table here plus fixtures, never a code branch. Ships Schwab and a
 * Generic profile this slice (Fidelity is a fast-follow table, not built here
 * without a real fixture to back it — "unknown is better than incorrect").
 *
 * Action keys are matched after normalizeHeader-style lowercasing/space-collapse
 * (see normalize.ts). Every action NOT in a table maps to UNKNOWN with raws
 * intact — the mapper is total.
 */

import { InvestmentEventType } from "@prisma/client";
import type { ActionRule, InvestmentImportProfile } from "./types";

const R = (type: InvestmentEventType, qty: ActionRule["qty"], cash: ActionRule["cash"]): ActionRule => ({ type, qty, cash });

const T = InvestmentEventType;

/**
 * Schwab "Transactions" CSV export. Quantities are unsigned magnitudes; the
 * action carries direction. "Amount" is signed in the file, but we re-derive FM
 * sign from the action so dedupe/reconstruction never depend on a provider's
 * sign convention.
 */
export const SCHWAB_PROFILE: InvestmentImportProfile = {
  key: "csv:schwab",
  label: "Charles Schwab",
  profileVersion: 1,
  defaultRowKind: "TRANSACTION",
  columnAliases: {
    tradeDate:   ["date", "run date"],
    action:      ["action"],
    symbol:      ["symbol"],
    description: ["description"],
    quantity:    ["quantity"],
    price:       ["price"],
    grossAmount: ["amount"],
    fees:        ["fees & comm", "fees & commissions"],
  },
  actionTable: {
    "buy":                     R(T.BUY, "in", "out"),
    "sell":                    R(T.SELL, "out", "in"),
    "reinvest shares":         R(T.REINVESTMENT, "in", "signed"),
    "reinvest dividend":       R(T.DIVIDEND, "none", "out"),
    "qualified dividend":      R(T.DIVIDEND, "none", "in"),
    "cash dividend":           R(T.DIVIDEND, "none", "in"),
    "special dividend":        R(T.DIVIDEND, "none", "in"),
    "bank interest":           R(T.INTEREST, "none", "in"),
    "credit interest":         R(T.INTEREST, "none", "in"),
    "long term cap gain":      R(T.CAPITAL_GAIN, "none", "in"),
    "short term cap gain":     R(T.CAPITAL_GAIN, "none", "in"),
    "advisor fee":             R(T.FEE, "none", "out"),
    "service fee":             R(T.FEE, "none", "out"),
    "foreign tax paid":        R(T.TAX, "none", "out"),
    "nra tax adj":             R(T.TAX, "none", "signed"),
    "stock split":             R(T.SPLIT, "none", "none"),   // ratio unknown here ⇒ recon stops
    "security transfer":       R(T.TRANSFER_IN, "signed", "none"),
    "moneylink transfer":      R(T.CONTRIBUTION, "none", "signed"),
    "wire funds":              R(T.WITHDRAWAL, "none", "out"),
    "wire funds received":     R(T.CONTRIBUTION, "none", "in"),
    "journal":                 R(T.TRANSFER_IN, "signed", "signed"),
  },
};

/**
 * Generic investment CSV — canonical headers, canonical action words. Any broker
 * not yet profiled imports through this by mapping their headers to the canonical
 * column contract in the wizard.
 */
export const GENERIC_PROFILE: InvestmentImportProfile = {
  key: "csv:generic",
  label: "Generic investment CSV",
  profileVersion: 1,
  defaultRowKind: "TRANSACTION",
  columnAliases: {},
  actionTable: {
    "buy":          R(T.BUY, "in", "out"),
    "sell":         R(T.SELL, "out", "in"),
    "reinvest":     R(T.REINVESTMENT, "in", "signed"),
    "reinvestment": R(T.REINVESTMENT, "in", "signed"),
    "dividend":     R(T.DIVIDEND, "none", "in"),
    "interest":     R(T.INTEREST, "none", "in"),
    "capital gain": R(T.CAPITAL_GAIN, "none", "in"),
    "fee":          R(T.FEE, "none", "out"),
    "tax":          R(T.TAX, "none", "out"),
    "split":        R(T.SPLIT, "none", "none"),
    "transfer in":  R(T.TRANSFER_IN, "in", "none"),
    "transfer out": R(T.TRANSFER_OUT, "out", "none"),
    "contribution": R(T.CONTRIBUTION, "none", "in"),
    "withdrawal":   R(T.WITHDRAWAL, "none", "out"),
    "opening":      R(T.OPENING_BALANCE, "in", "none"),
    "opening balance": R(T.OPENING_BALANCE, "in", "none"),
  },
};

export const INVESTMENT_PROFILES: Record<string, InvestmentImportProfile> = {
  [SCHWAB_PROFILE.key]:  SCHWAB_PROFILE,
  [GENERIC_PROFILE.key]: GENERIC_PROFILE,
};

export function getInvestmentProfile(key: string | null | undefined): InvestmentImportProfile {
  return (key && INVESTMENT_PROFILES[key]) || GENERIC_PROFILE;
}
