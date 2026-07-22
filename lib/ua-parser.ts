/**
 * lib/ua-parser.ts
 *
 * Lightweight user-agent parser — no external dependencies.
 * Returns browser name, OS, and device type from a UA string.
 * Intentionally simple; upgrade to ua-parser-js if richer data is needed.
 */

export type ParsedUA = {
  browser: string;
  os:      string;
  device:  string;
};

/**
 * Natural-language device label for a parsed UA. Avoids ever rendering
 * "Unknown on Unknown" (which happens for audit events stored without a
 * user-agent): degrades to "Unknown device", or keeps whichever half is known.
 * Presentation-only — parseUserAgent's data is unchanged.
 */
export function formatDevice(parsed: ParsedUA): string {
  const browserUnknown = parsed.browser === "Unknown";
  const osUnknown      = parsed.os === "Unknown";

  if (browserUnknown && osUnknown) return "Unknown device";
  if (browserUnknown)              return `Unknown browser on ${parsed.os}`;
  if (osUnknown)                   return `${parsed.browser} on an unknown operating system`;
  return `${parsed.browser} on ${parsed.os}`;
}

export function parseUserAgent(ua: string): ParsedUA {
  if (!ua) return { browser: "Unknown", os: "Unknown", device: "Unknown" };

  // ── Browser ────────────────────────────────────────────────────────────────
  let browser = "Unknown";
  if      (/Edg\//.test(ua))        browser = "Edge";
  else if (/OPR\/|Opera/.test(ua))  browser = "Opera";
  else if (/Chrome\//.test(ua))     browser = "Chrome";
  else if (/Safari\//.test(ua))     browser = "Safari";
  else if (/Firefox\//.test(ua))    browser = "Firefox";
  else if (/MSIE|Trident/.test(ua)) browser = "Internet Explorer";

  // Try to append version
  const verMatch =
    ua.match(/(?:Chrome|Firefox|Safari|Edg|OPR)\/(\d+)/) ??
    ua.match(/Version\/(\d+)/);
  if (verMatch) browser += ` ${verMatch[1]}`;

  // ── OS ─────────────────────────────────────────────────────────────────────
  let os = "Unknown";
  if      (/Windows NT 10/.test(ua))  os = "Windows 10/11";
  else if (/Windows NT 6\.3/.test(ua)) os = "Windows 8.1";
  else if (/Windows/.test(ua))         os = "Windows";
  else if (/iPhone OS ([\d_]+)/.test(ua)) {
    const v = ua.match(/iPhone OS ([\d_]+)/)?.[1].replace(/_/g, ".") ?? "";
    os = `iOS ${v}`;
  }
  else if (/iPad.*OS ([\d_]+)/.test(ua)) {
    const v = ua.match(/CPU OS ([\d_]+)/)?.[1].replace(/_/g, ".") ?? "";
    os = `iPadOS ${v}`;
  }
  else if (/Android ([\d.]+)/.test(ua)) {
    const v = ua.match(/Android ([\d.]+)/)?.[1] ?? "";
    os = `Android ${v}`;
  }
  else if (/Mac OS X ([\d_]+)/.test(ua)) {
    const v = ua.match(/Mac OS X ([\d_]+)/)?.[1].replace(/_/g, ".") ?? "";
    os = `macOS ${v}`;
  }
  else if (/Linux/.test(ua))           os = "Linux";

  // ── Device ─────────────────────────────────────────────────────────────────
  let device = "Desktop";
  if      (/iPhone/.test(ua))  device = "iPhone";
  else if (/iPad/.test(ua))    device = "iPad";
  else if (/Android.*Mobile/.test(ua)) device = "Android Phone";
  else if (/Android/.test(ua)) device = "Android Tablet";
  else if (/Macintosh/.test(ua)) device = "Mac";
  else if (/Windows/.test(ua))   device = "PC";

  return { browser, os, device };
}
