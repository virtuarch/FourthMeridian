"use client";

import { useSyncExternalStore } from "react";

/**
 * useAtlasLiquid — decides whether the Atlas **Liquid** material renders, or the
 * Atlas **Glass** fallback. Liquid is on by default (no env var), gated by
 * capability, with a URL-only override:
 *
 *   ?atlasLiquid=0  → force the Glass fallback
 *   ?atlasLiquid=1  → force Liquid (skips capability checks; for testing)
 *
 * Otherwise Liquid is used only when WebGL is available AND the user has NOT
 * requested `prefers-reduced-transparency`.
 *
 * The value is client-only and fixed for the page's lifetime, so we read it via
 * useSyncExternalStore: the server snapshot is `false` (SSR + hydration render
 * the Glass fallback), and the client snapshot upgrades to Liquid when supported.
 * This is SSR-safe and avoids setting state inside an effect.
 */
const subscribe = () => () => {};
const getServerSnapshot = () => false;

export function useAtlasLiquid(): boolean {
  return useSyncExternalStore(subscribe, computeAtlasLiquid, getServerSnapshot);
}

function computeAtlasLiquid(): boolean {
  if (typeof window === "undefined") return false;

  const override = new URLSearchParams(window.location.search).get("atlasLiquid");
  if (override === "0") return false;
  if (override === "1") return true;

  if (window.matchMedia?.("(prefers-reduced-transparency: reduce)").matches) {
    return false;
  }
  return hasWebGL();
}

let webglSupport: boolean | null = null;
function hasWebGL(): boolean {
  if (webglSupport !== null) return webglSupport;
  try {
    const canvas = document.createElement("canvas");
    webglSupport = !!(
      window.WebGLRenderingContext &&
      (canvas.getContext("webgl") || canvas.getContext("experimental-webgl"))
    );
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}
