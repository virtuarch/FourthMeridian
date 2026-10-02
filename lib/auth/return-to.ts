/**
 * lib/auth/return-to.ts — the ONE validator for a post-authentication return
 * target (`?callbackUrl=`).
 *
 * WHY THIS EXISTS. The login page used to accept any `callbackUrl` that began
 * with "/", and `//evil.com` begins with "/". The Next router treats a
 * protocol-relative value as external and performs a full navigation to it, so
 * a link of the form `/login?callbackUrl=//evil.com` sent a user who had just
 * typed their password to a host of the attacker's choosing — a phishing
 * primitive wearing our domain. `/\evil.com` is the same hole (browsers
 * normalise "\" to "/"), as are their percent-encoded spellings.
 *
 * THE RULE. A return target is accepted only if it is a same-origin PATH:
 *   - a string, at most MAX_RETURN_TO_LENGTH characters;
 *   - beginning with exactly one "/" (never "//", never "/\");
 *   - no backslash, ASCII control character or raw whitespace anywhere in the
 *     raw value;
 *   - the PATH (before any "?" or "#") stays safe in every percent-decoded
 *     form: no leading "//", no backslash, no control character — so
 *     `/%2F%2Fevil.com` and `/%5Cevil.com` are refused, and a double-encoded
 *     `/%252F%252Fevil.com` is refused at the second decode. The query and
 *     fragment are not decoded: they cannot change the origin, and legitimate
 *     deep-link state is percent-encoded there;
 *   - malformed percent-encoding in the path is refused, never "best-effort"
 *     decoded;
 *   - resolving it against a fixed origin must not change the origin.
 * Anything else falls back to DEFAULT_RETURN_TO.
 *
 * AUTH PAGES ARE NOT RETURN TARGETS. A signed-in user sent back to /login is
 * redirected by /login to its return target — so `/login?callbackUrl=/login`
 * would loop. Every route in AUTH_ENTRY_PATHS falls back instead.
 *
 * Query strings and fragments are preserved as written: nearly all deep-link
 * state (tab, perspective, asof, …) lives in the query (see proxy.ts).
 *
 * Pure: no imports. proxy.ts imports it and keeps a zero-dependency graph.
 */

/** The authenticated application's normal landing route. */
export const DEFAULT_RETURN_TO = "/dashboard/brief";

export const MAX_RETURN_TO_LENGTH = 2048;

/**
 * Unauthenticated entry pages. Never a return target: a signed-in visitor is
 * bounced OFF these, so returning to one would loop or strand the user.
 */
export const AUTH_ENTRY_PATHS: readonly string[] = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/confirm-email-change",
];

// A fixed, unresolvable base. Only used to ask "does resolving this value
// change the origin?" — never fetched, never emitted.
const PROBE_ORIGIN = "https://return-to.invalid";

// Raw value: control characters (C0 + DEL), space, and backslash.
const FORBIDDEN_RAW = /[\x00-\x20\x7f\\]/;
// Decoded path: control characters and backslash. (An encoded space is a
// legitimate path byte and cannot move the origin.)
const FORBIDDEN_DECODED = /[\x00-\x1f\x7f\\]/;

const MAX_DECODE_PASSES = 3;

function isSafePath(s: string): boolean {
  if (FORBIDDEN_DECODED.test(s)) return false;
  if (!s.startsWith("/")) return false;
  if (s.startsWith("//")) return false;
  return true;
}

/**
 * Returns `raw` if it is a safe same-origin return path, otherwise `null`.
 * Prefer `safeReturnTo` at call sites; this form exists so a caller can tell
 * "absent" from "refused" when it needs to.
 */
export function validateReturnTo(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_RETURN_TO_LENGTH) return null;
  if (FORBIDDEN_RAW.test(raw)) return null;

  // Every decoded spelling of the PATH must be as safe as the raw one. Stop once
  // decoding reaches a fixed point; refuse if it never does within the budget.
  let current = raw.split(/[?#]/, 1)[0];
  for (let pass = 0; ; pass++) {
    if (!isSafePath(current)) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null; // malformed %-sequence
    }
    if (decoded === current) break;
    if (pass + 1 >= MAX_DECODE_PASSES) return null;
    current = decoded;
  }

  let resolved: URL;
  try {
    resolved = new URL(raw, PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (resolved.origin !== PROBE_ORIGIN) return null;

  // Judge the loop rule on the fully DECODED path, case-folded: `/%6Cogin` and
  // `/Login/` must not slip past it into a /login ⇄ /login bounce.
  const path = current.toLowerCase();
  if (AUTH_ENTRY_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return null;

  return raw;
}

/** `raw` if it is a safe same-origin return path, otherwise `fallback`. */
export function safeReturnTo(raw: unknown, fallback: string = DEFAULT_RETURN_TO): string {
  return validateReturnTo(raw) ?? fallback;
}

/** `/login`, carrying `returnTo` as `callbackUrl` only when it is safe. */
export function loginUrlFor(returnTo: unknown): string {
  const safe = validateReturnTo(returnTo);
  return safe ? `/login?callbackUrl=${encodeURIComponent(safe)}` : "/login";
}
