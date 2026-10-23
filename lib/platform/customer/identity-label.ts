/**
 * lib/platform/customer/identity-label.ts  (P1 — owner ruling, 2026-10-08)
 *
 * USERNAME FIRST on operator surfaces. A customer is identified by username in
 * lists, tables and search results; email stays in the detail view, the
 * identity model, auth, search and audit.
 *
 * `User.username` is nullable in the schema (`String? @unique`) but required at
 * registration and present on every row of the dev and Preview corpora
 * (verified 2026-10-08), so the fallback exists for a legacy or
 * partially-registered row and NEVER fabricates a username from an email: it
 * shows the name when one exists, else an opaque reference to the id.
 *
 * ⚠️ PURE AND IMPORT-FREE ON PURPOSE. Client widgets ("use client") import this;
 * customer-core.ts (which reaches server-only modules) re-exports it for server
 * callers. Importing customer-core from a widget pulled `server-only` into the
 * browser bundle and failed the Preview build (2026-10-07, Turbopack).
 */

export interface OperatorIdentityLike { id: string; username: string | null; name?: string | null }

export function operatorDisplayName(u: OperatorIdentityLike): string {
  if (u.username && u.username.trim()) return u.username.trim();
  if (u.name && u.name.trim()) return u.name.trim();
  return `user …${u.id.slice(-6)}`;
}
