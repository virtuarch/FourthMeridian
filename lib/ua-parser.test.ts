/**
 * lib/ua-parser.test.ts  (OPS-2 polish)
 *
 * Pure guards for formatDevice — the Security History device label must never
 * render "Unknown on Unknown". Standalone tsx script:
 *
 *     npx tsx lib/ua-parser.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network.
 */

import { formatDevice, parseUserAgent } from "@/lib/ua-parser";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("ua-parser / formatDevice");

// The reported bug: an empty UA parsed to Unknown/Unknown rendered "Unknown on Unknown".
const empty = formatDevice(parseUserAgent(""));
check("empty UA → 'Unknown device'", empty === "Unknown device", empty);
check("empty UA never contains 'Unknown on Unknown'", !empty.includes("Unknown on Unknown"));

// Half-known cases keep the known part.
check(
  "unknown browser, known OS",
  formatDevice({ browser: "Unknown", os: "Windows 10/11", device: "PC" }) === "Unknown browser on Windows 10/11",
);
check(
  "known browser, unknown OS",
  formatDevice({ browser: "Chrome 120", os: "Unknown", device: "Desktop" }) === "Chrome 120 on an unknown operating system",
);

// Fully known is unchanged from the previous format.
check(
  "both known → '{browser} on {os}'",
  formatDevice({ browser: "Safari 17", os: "iOS 17.2", device: "iPhone" }) === "Safari 17 on iOS 17.2",
);

// Broad guarantee across a few real-ish UAs: never "Unknown on Unknown".
const uas = [
  "",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile/15E Safari/604",
  "curl/8.1.2",
  "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36",
];
check(
  "no UA ever renders 'Unknown on Unknown'",
  uas.every((ua) => !formatDevice(parseUserAgent(ua)).includes("Unknown on Unknown")),
);

console.log(failures === 0 ? "\nAll formatDevice checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
