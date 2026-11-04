/**
 * scripts/lib/b10-rehearsal-guard.ts  (B10.6 — the probes' refusal guard; S2)
 *
 * The two rehearsal probes (scripts/test-b10-rehearsal-b9-probe.ts and
 * scripts/test-b10-rehearsal-b10-probe.ts) write incidents, sessions, audit
 * rows and accounts. They must never run against anything but the throwaway
 * database the orchestrator (scripts/test-b10-rollback-rehearsal.ts) just built.
 *
 * So each probe calls guardRehearsalProbe() FIRST, before any application
 * module (and so before lib/db binds a client) is imported. It refuses —
 * exit 1, nothing read — unless ALL of:
 *   (a) B10REH_FIX is set, non-empty, and a JSON object (no default fixture);
 *       B10REH_STATE likewise (the orchestrator always passes one);
 *   (b) DATABASE_URL is set, and EVERY set DATABASE_URL / DIRECT_URL /
 *       DATABASE_URL_APP / DATABASE_URL_AUTH / DATABASE_URL_SYSTEM has host
 *       127.0.0.1 AND a database name starting with REHEARSAL_DB_PREFIX
 *       (the orchestrator generates that name);
 *   (c) B10REH_ORCHESTRATED is the orchestrator's container name
 *       (REHEARSAL_CONTAINER_PREFIX…).
 *
 * PURE apart from guardRehearsalProbe()'s exit: no imports beyond the
 * standard URL parser, no network, no file system. This file is copied into
 * the B9 worktree beside the B9 probe, so it must not import anything from
 * the develop tree.
 */

export const REHEARSAL_DB_PREFIX = "b10reh_";
export const REHEARSAL_CONTAINER_PREFIX = "fm-b10reh-";
export const REHEARSAL_URL_VARS = ["DATABASE_URL", "DIRECT_URL", "DATABASE_URL_APP", "DATABASE_URL_AUTH", "DATABASE_URL_SYSTEM"] as const;

export type GuardVerdict =
  | { ok: true; fix: Record<string, string>; state: Record<string, unknown> }
  | { ok: false; reasons: string[] };

function jsonObject(name: string, raw: string | undefined, reasons: string[]): Record<string, unknown> | null {
  if (!raw || !raw.trim()) { reasons.push(`${name} is not set`); return null; }
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fall through */ }
  reasons.push(`${name} is not a JSON object`);
  return null;
}

/** Never echoes a URL, a password or a host — only the variable name and what is wrong. */
export function checkRehearsalEnv(env: Record<string, string | undefined>): GuardVerdict {
  const reasons: string[] = [];
  const fix = jsonObject("B10REH_FIX", env.B10REH_FIX, reasons);
  if (fix && Object.keys(fix).length === 0) reasons.push("B10REH_FIX is empty");
  const state = jsonObject("B10REH_STATE", env.B10REH_STATE, reasons);

  if (!env.DATABASE_URL) reasons.push("DATABASE_URL is not set");
  for (const name of REHEARSAL_URL_VARS) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    let u: URL;
    try { u = new URL(raw); } catch { reasons.push(`${name} is not a URL`); continue; }
    if (!/^postgres(ql)?:$/.test(u.protocol)) reasons.push(`${name} is not a postgres URL`);
    if (u.hostname !== "127.0.0.1") reasons.push(`${name} host is not 127.0.0.1`);
    const dbName = decodeURIComponent(u.pathname.replace(/^\//, ""));
    if (!dbName.startsWith(REHEARSAL_DB_PREFIX)) reasons.push(`${name} database is not a ${REHEARSAL_DB_PREFIX}* rehearsal database`);
  }

  const marker = env.B10REH_ORCHESTRATED ?? "";
  if (!marker.startsWith(REHEARSAL_CONTAINER_PREFIX) || marker.length <= REHEARSAL_CONTAINER_PREFIX.length) {
    reasons.push("B10REH_ORCHESTRATED is not the orchestrator's container name");
  }

  return reasons.length || !fix || !state
    ? { ok: false, reasons }
    : { ok: true, fix: fix as Record<string, string>, state };
}

/** Call FIRST in a probe. Exits 1 (printing only the reasons) on any refusal. */
export function guardRehearsalProbe(env: Record<string, string | undefined> = process.env): { fix: Record<string, string>; state: Record<string, unknown> } {
  const v = checkRehearsalEnv(env);
  if (!v.ok) {
    console.error(`B10REH REFUSED: this probe runs only inside scripts/test-b10-rollback-rehearsal.ts against its throwaway database.\n  - ${v.reasons.join("\n  - ")}`);
    process.exit(1);
  }
  return { fix: v.fix, state: v.state };
}
