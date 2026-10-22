/**
 * UI-006 (remaining surfaces) — ConnectionMenu and ActiveSessions report failures.
 * Both are client components whose behaviour sits in fetch handlers, so these are
 * source pins on the exact contract (the house pattern for client components).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
let f = 0;
const check = (n: string, ok: boolean) => { if (!ok) f++; console.log(`  ${ok ? "✓" : "✗"} ${n}`); };
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const menu = read("components/connections/ConnectionMenu.tsx");
check("ConnectionMenu: fetch failures are no longer swallowed by .catch(() => {})", !/\.catch\(\(\) => \{\}\)/.test(menu));
check("ConnectionMenu: post() returns an error message on !res.ok", /if \(res\.ok\) return null;/.test(menu));
check("ConnectionMenu: every action awaits post() and records a failure", (menu.match(/const err = await post\(/g) ?? []).length === 3 && (menu.match(/if \(err\) setFailure\(err\);/g) ?? []).length === 3);
check("ConnectionMenu: the failure renders as an alert", /role="alert"[\s\S]{0,80}\{failure\}|\{failure && \(\s*<p role="alert"/.test(menu));

const sess = read("components/security/ActiveSessions.tsx");
check("ActiveSessions: a failed read is an error, never an empty list", /if \(!res\.ok\) return \{ sessions: \[\], error:/.test(sess) && !/return Array\.isArray\(data\.sessions\) \? data\.sessions : \[\];/.test(sess));
check("ActiveSessions: a failed revoke says the session may still be signed in", /It may still be signed in/.test(sess) && /if \(!res\.ok\) failed =/.test(sess));
check("ActiveSessions: 'No active sessions' only when the read succeeded", /return error \? errorBanner : <p[^>]*>No active sessions\.<\/p>;/.test(sess));
check("ActiveSessions: the error is announced with a Retry", /role="alert"[\s\S]{0,600}>Retry</.test(sess));
if (f) process.exit(1);
console.log("\nall checks passed");
