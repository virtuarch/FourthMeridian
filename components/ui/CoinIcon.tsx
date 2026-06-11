"use client";

import { useState } from "react";

// ── Crypto logos ──────────────────────────────────────────────────────────────
// Source: https://github.com/spothq/cryptocurrency-icons (MIT license)
const CRYPTO_CDN = "https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/svg/color";

const CRYPTO_SYMBOLS = new Set([
  "BTC","ETH","SOL","BNB","ADA","XRP","DOGE","MATIC","DOT","AVAX",
  "LINK","UNI","LTC","ATOM","ALGO","FTM","NEAR","SAND","MANA","CRO",
  "VET","SHIB","TRX","EOS","AAVE","COMP","MKR","SNX","YFI","SUSHI",
  "BAL","CRV","1INCH","GRT","ENJ","ZEC","DASH","XMR","HBAR","IOTA",
  "NEO","WAVES","QTUM","ICX","ZIL","ONT","OMG","HOT","THETA","FIL",
]);

// ── Stock logos via Financial Modeling Prep ───────────────────────────────────
// Some tickers have special chars (BRK.B → BRKB on FMP)
const FMP_LOGO = (symbol: string) =>
  `https://financialmodelingprep.com/image-stock/${symbol.toUpperCase().replace(/[^A-Z0-9]/g, "")}.png`;

// Exchange abbreviations we generate via exchangeSymbol().
// "CB" = Coinbase here, but "CB" is also Chubb on NYSE — FMP returns Chubb's logo.
// Skip FMP entirely for these and go straight to the letter-badge fallback.
const SKIP_STOCK_LOGO = new Set([
  "CB", "GEM", "KRK", "BFX", "OKX", "KCS", "BYB", "BST", "FTX",
]);

// Accent colors for the letter-badge fallback
const FALLBACK_COLORS: Record<string, string> = {
  // Tech / Semis
  AAPL: "bg-gray-700",    MSFT: "bg-blue-800",   NVDA: "bg-green-800",
  GOOGL: "bg-blue-900",   AMZN: "bg-yellow-800", META: "bg-blue-700",
  TSLA: "bg-red-800",     NFLX: "bg-red-900",    AMD:  "bg-red-700",
  INTC: "bg-blue-900",    CRM:  "bg-blue-700",   ADBE: "bg-red-800",
  SMCI: "bg-green-800",
  // Quantum / AI
  RGTI: "bg-indigo-800",  IONQ: "bg-indigo-900", QBTS: "bg-violet-800",
  QUBT: "bg-violet-900",
  // Fintech / growth
  PLTR: "bg-indigo-800",  SOFI: "bg-violet-700", COIN: "bg-blue-700",
  // Crypto exchanges (display symbols from exchangeSymbol helper)
  CB:   "bg-blue-700",    GEM:  "bg-sky-800",    KRK:  "bg-violet-800",
  BNB:  "bg-yellow-800",  BFX:  "bg-gray-700",   OKX:  "bg-gray-700",
  KCS:  "bg-green-800",   BYB:  "bg-orange-800", BST:  "bg-blue-900",
  // ETFs
  VTI:  "bg-violet-900",  VOO:  "bg-violet-900", SPY:  "bg-violet-800",
  QQQ:  "bg-blue-900",    IWM:  "bg-violet-800", VGT:  "bg-violet-900",
  ARKK: "bg-indigo-800",  SCHB: "bg-blue-800",   VXUS: "bg-violet-800",
  BND:  "bg-teal-900",
  // Finance
  JPM:  "bg-blue-900",    BAC:  "bg-red-900",    GS:   "bg-blue-800",
  V:    "bg-blue-900",    MA:   "bg-red-900",    "BRK.B": "bg-gray-700",
};

interface Props {
  symbol: string;
  size?: number;
}

export function CoinIcon({ symbol, size = 36 }: Props) {
  const [cryptoFailed, setCryptoFailed] = useState(false);
  const [stockFailed,  setStockFailed]  = useState(false);

  const upper      = symbol.toUpperCase();
  const isCrypto   = CRYPTO_SYMBOLS.has(upper);
  const skipStock  = SKIP_STOCK_LOGO.has(upper);
  const fallbackBg = FALLBACK_COLORS[upper] ?? (isCrypto ? "bg-yellow-500/10 border border-yellow-500/20" : "bg-gray-800");
  const fallbackText = isCrypto ? "text-yellow-400" : "text-white";

  // ── Crypto icon ─────────────────────────────────────────────────────────────
  if (isCrypto && !cryptoFailed) {
    return (
      <div
        style={{ width: size, height: size }}
        className="rounded-xl overflow-hidden flex items-center justify-center bg-gray-900 shrink-0"
      >
        <img
          src={`${CRYPTO_CDN}/${upper.toLowerCase()}.svg`}
          alt={upper}
          width={size - 6}
          height={size - 6}
          onError={() => setCryptoFailed(true)}
          className="object-contain"
        />
      </div>
    );
  }

  // ── Stock / ETF icon via FMP (skip for exchange abbreviations) ───────────────
  if (!isCrypto && !skipStock && !stockFailed) {
    return (
      <div
        style={{ width: size, height: size }}
        className="rounded-xl overflow-hidden flex items-center justify-center bg-white shrink-0"
      >
        <img
          src={FMP_LOGO(upper)}
          alt={upper}
          width={size - 4}
          height={size - 4}
          onError={() => setStockFailed(true)}
          className="object-contain rounded-lg"
        />
      </div>
    );
  }

  // ── Letter-badge fallback ─────────────────────────────────────────────────────
  // ≤4 chars: show full ticker (BTC, VTI, TSLA, CB). 5+ chars: first letter only.
  const label    = upper.length <= 4 ? upper : upper[0];
  const fontSize = label.length <= 2 ? size * 0.38 : label.length === 3 ? size * 0.31 : size * 0.26;

  return (
    <div
      style={{ width: size, height: size }}
      className={`rounded-xl flex items-center justify-center shrink-0 ${fallbackBg}`}
    >
      <span className={`font-bold leading-none ${fallbackText}`} style={{ fontSize }}>
        {label}
      </span>
    </div>
  );
}
