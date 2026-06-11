/**
 * lib/exchangeSymbol.ts
 *
 * Maps a crypto exchange institution name to a short display symbol
 * used when an account has no walletChain (i.e. it's an exchange, not
 * a self-custody wallet).
 *
 * Examples:
 *   "Coinbase"  → "CB"
 *   "Gemini"    → "GEM"
 *   "Kraken"    → "KRK"
 *   "Unknown"   → first 2 letters of institution name
 */

const EXCHANGE_MAP: Record<string, string> = {
  "Coinbase":       "CB",
  "Coinbase Pro":   "CB",
  "Gemini":         "GEM",
  "Kraken":         "KRK",
  "Binance":        "BNB",
  "Binance.US":     "BNB",
  "Bitfinex":       "BFX",
  "Bitstamp":       "BST",
  "OKX":            "OKX",
  "KuCoin":         "KCS",
  "Bybit":          "BYB",
  "FTX":            "FTX",
};

export function exchangeSymbol(institution: string): string {
  return EXCHANGE_MAP[institution] ?? institution.slice(0, 2).toUpperCase();
}
