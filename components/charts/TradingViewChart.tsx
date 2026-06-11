"use client";

import { useEffect, useId, useRef } from "react";

// Maps our internal symbols to TradingView symbols
const SYMBOL_MAP: Record<string, string> = {
  // Crypto
  BTC: "BINANCE:BTCUSDT",
  ETH: "BINANCE:ETHUSDT",
  SOL: "BINANCE:SOLUSDT",
  BNB: "BINANCE:BNBUSDT",
  MATIC: "BINANCE:MATICUSDT",
  ADA: "BINANCE:ADAUSDT",
  XRP: "BINANCE:XRPUSDT",
  DOGE: "BINANCE:DOGEUSDT",
  // Stocks
  AAPL: "NASDAQ:AAPL",
  MSFT: "NASDAQ:MSFT",
  NVDA: "NASDAQ:NVDA",
  GOOGL: "NASDAQ:GOOGL",
  AMZN: "NASDAQ:AMZN",
  META: "NASDAQ:META",
  TSLA: "NASDAQ:TSLA",
  INTC: "NASDAQ:INTC",
  AMD:  "NASDAQ:AMD",
  RGTI: "NASDAQ:RGTI",
  PLTR: "NASDAQ:PLTR",
  SOFI: "NASDAQ:SOFI",
  COIN: "NASDAQ:COIN",
  SMCI: "NASDAQ:SMCI",
  IONQ: "NYSE:IONQ",
  QBTS: "NYSE:QBTS",
  QUBT: "NASDAQ:QUBT",
  JPM:  "NYSE:JPM",
  BAC:  "NYSE:BAC",
  GS:   "NYSE:GS",
  V:    "NYSE:V",
  MA:   "NYSE:MA",
  // ETFs
  VTI:  "AMEX:VTI",
  VOO:  "AMEX:VOO",
  SPY:  "AMEX:SPY",
  QQQ:  "NASDAQ:QQQ",
  ARKK: "AMEX:ARKK",
  IWM:  "AMEX:IWM",
};

declare global {
  interface Window {
    TradingView: {
      widget: new (config: object) => void;
    };
  }
}

interface Props {
  symbol: string;
  height?: number;
}

export function TradingViewChart({ symbol, height = 420 }: Props) {
  const uid = useId();
  const containerId = `tv_${symbol}_${uid.replace(/:/g, "")}`;
  const scriptRef = useRef<HTMLScriptElement | null>(null);

  const tvSymbol = SYMBOL_MAP[symbol.toUpperCase()] ?? symbol;

  useEffect(() => {
    const id = containerId;

    function initWidget() {
      if (typeof window.TradingView === "undefined") return;
      new window.TradingView.widget({
        container_id: id,
        symbol: tvSymbol,
        interval: "D",
        timezone: "America/New_York",
        theme: "dark",
        style: "1",
        locale: "en",
        toolbar_bg: "#111827",
        enable_publishing: false,
        hide_top_toolbar: false,
        hide_side_toolbar: false,
        allow_symbol_change: true,
        save_image: false,
        height,
        width: "100%",
        backgroundColor: "rgba(17, 24, 39, 1)",
        gridColor: "rgba(55, 65, 81, 0.5)",
      });
    }

    // Load TV.js once
    if (!document.getElementById("tv-script")) {
      const script = document.createElement("script");
      script.id = "tv-script";
      script.src = "https://s3.tradingview.com/tv.js";
      script.async = true;
      script.onload = initWidget;
      document.head.appendChild(script);
      scriptRef.current = script;
    } else {
      // Script already loaded
      initWidget();
    }

    return () => {
      // Clean up the container contents on unmount
      const el = document.getElementById(id);
      if (el) el.innerHTML = "";
    };
  }, [tvSymbol, height, containerId]);

  return (
    <div
      id={containerId}
      style={{ height }}
      className="w-full rounded-xl overflow-hidden bg-gray-900"
    />
  );
}
