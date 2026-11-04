/**
 * jobs/network-identifier-minimisation.ts  (S2 P8 item 3 — IP / user-agent minimisation, engineering half)
 *
 * The retention job for network identifiers (lib/privacy/network-identifiers.ts),
 * behind ONE setting that DEFAULTS OFF:
 *
 *   NETWORK_ID_MINIMISATION_MODE   off (default) | dry_run | apply
 *
 * Read from the environment at call time — the house pattern for a job that
 * ships disabled (SOL_BACKFILL_ENABLED, jobs/sol-history-backfill.ts). Unset,
 * empty or any unrecognised value is OFF (fail closed), so the default
 * behaviour is unchanged: nothing reads or writes.
 *
 *   off      returns at once; no database call of any kind.
 *   dry_run  READ-ONLY census: for every registered field, the number of rows
 *            holding a raw value, per age band (< 30 d, 30–90 d, 90–180 d,
 *            > 180 d). Its client type has `count` only — it cannot write.
 *   apply    in this build, REFUSES every field (and still reports the
 *            read-only counts): AuditLog fields with the DB-010 message (the
 *            append-only policy admits no wider UPDATE — the extension is
 *            designed, not migrated, in docs/operations/data-retention.md);
 *            UserSession and RateLimit with the owner-decision message (window
 *            and method are undecided). No write path exists here.
 *
 * NOT SCHEDULED. It is not in lib/jobs/registry.ts and no cron names it; the
 * owner decision is a precondition to registering it. The minimisation
 * functions it will call are in lib/privacy/network-minimise.ts.
 */

import type { Prisma } from "@prisma/client";
import {
  NETWORK_IDENTIFIER_FIELDS, applyRefusal,
  type NetworkIdentifierField, type NetworkIdentifierModel,
} from "@/lib/privacy/network-identifiers";

export const NETWORK_ID_MINIMISATION_ENV = "NETWORK_ID_MINIMISATION_MODE";
export const NETWORK_ID_MINIMISATION_MODES = ["off", "dry_run", "apply"] as const;
export type NetworkIdMinimisationMode = typeof NETWORK_ID_MINIMISATION_MODES[number];
export const NETWORK_ID_MINIMISATION_DEFAULT: NetworkIdMinimisationMode = "off";

/** The setting, from the env. Anything but an exact known value is OFF. */
export function resolveNetworkIdMinimisationMode(source: Record<string, string | undefined> = process.env): NetworkIdMinimisationMode {
  const raw = (source[NETWORK_ID_MINIMISATION_ENV] ?? "").trim().toLowerCase();
  return (NETWORK_ID_MINIMISATION_MODES as readonly string[]).includes(raw) ? (raw as NetworkIdMinimisationMode) : NETWORK_ID_MINIMISATION_DEFAULT;
}

const DAY_MS = 86_400_000;

/** The age bands of the census, in days: [fromDays, toDays) — `toDays` null = open-ended. */
export const AGE_BANDS = [
  { band: "<30d", fromDays: 0, toDays: 30 },
  { band: "30-90d", fromDays: 30, toDays: 90 },
  { band: "90-180d", fromDays: 90, toDays: 180 },
  { band: ">180d", fromDays: 180, toDays: null },
] as const;
export type AgeBand = typeof AGE_BANDS[number]["band"];

/** Read-only by type: the census can only count. */
export interface CountDelegate { count(args: { where: Record<string, unknown> }): Promise<number> }
export type CensusClient = { auditLog: CountDelegate; userSession: CountDelegate; rateLimit: CountDelegate };

const DELEGATE: Record<NetworkIdentifierModel, keyof CensusClient> = {
  AuditLog: "auditLog", UserSession: "userSession", RateLimit: "rateLimit",
};

/** Rows holding a raw value of the field (typed against Prisma so a wrong filter fails tsc). */
export function rawPresenceWhere(f: NetworkIdentifierField): Record<string, unknown> {
  switch (f.id) {
    case "AuditLog.ipAddress":
      return { ipAddress: { not: null } } satisfies Prisma.AuditLogWhereInput;
    case "AuditLog.userAgent":
      return { userAgent: { not: null } } satisfies Prisma.AuditLogWhereInput;
    case "AuditLog.metadata.key":
      // O-8: `ip:h<32 hex>` is the stored digest, not a raw address ("h" is not an IP character).
      return { action: "SECURITY_ANOMALY_DETECTED", AND: [
        { metadata: { path: ["key"], string_starts_with: "ip:" } },
        { NOT: { metadata: { path: ["key"], string_starts_with: "ip:h" } } },
      ] } satisfies Prisma.AuditLogWhereInput;
    case "UserSession.ipAddress":
      return { ipAddress: { not: null } } satisfies Prisma.UserSessionWhereInput;
    case "UserSession.userAgent":
      return { userAgent: { not: null } } satisfies Prisma.UserSessionWhereInput;
    case "RateLimit.key":
      return { key: { startsWith: "ip:" } } satisfies Prisma.RateLimitWhereInput;
    default:
      // A registered field without a presence filter is a build defect: refuse to guess.
      throw new Error(`no raw-presence filter for registered field ${f.id}`);
  }
}

/** The age window of one band on the field's age column: older than `fromDays`, not older than `toDays`. */
export function bandWhere(f: NetworkIdentifierField, b: typeof AGE_BANDS[number], now: Date): Record<string, unknown> {
  const range: { lte: Date; gt?: Date } = { lte: new Date(now.getTime() - b.fromDays * DAY_MS) };
  if (b.toDays !== null) range.gt = new Date(now.getTime() - b.toDays * DAY_MS);
  return { [f.ageColumn]: range };
}

export interface FieldCensus {
  id: string;
  model: NetworkIdentifierModel;
  kind: NetworkIdentifierField["kind"];
  counts: Record<AgeBand, number> | null;
  /** Set when apply was requested: why nothing was written. */
  refused?: string;
  error?: string;
}

export interface NetworkIdMinimisationResult {
  mode: NetworkIdMinimisationMode;
  /** False in OFF mode: nothing was read or written. */
  ran: boolean;
  /** Always 0 in this build. */
  written: 0;
  asOf: string;
  fields: FieldCensus[];
}

export async function runNetworkIdentifierMinimisation(
  opts: { client?: CensusClient; now?: Date; env?: Record<string, string | undefined> } = {},
): Promise<NetworkIdMinimisationResult> {
  const now = opts.now ?? new Date();
  const mode = resolveNetworkIdMinimisationMode(opts.env ?? process.env);
  const out: NetworkIdMinimisationResult = { mode, ran: false, written: 0, asOf: now.toISOString(), fields: [] };
  if (mode === "off") return out;

  const client = opts.client ?? ((await import("@/lib/db")).systemDb as unknown as CensusClient);
  out.ran = true;
  for (const f of NETWORK_IDENTIFIER_FIELDS) {
    const row: FieldCensus = { id: f.id, model: f.model, kind: f.kind, counts: null };
    if (mode === "apply") row.refused = applyRefusal(f);
    try {
      const presence = rawPresenceWhere(f);
      const counts = {} as Record<AgeBand, number>;
      for (const b of AGE_BANDS) {
        counts[b.band] = await client[DELEGATE[f.model]].count({ where: { AND: [presence, bandWhere(f, b, now)] } });
      }
      row.counts = counts;
    } catch (err) {
      row.error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
      console.error(`[network-id-minimisation] census of ${f.id} failed (others continue):`, err);
    }
    out.fields.push(row);
  }
  if (mode === "apply") console.warn(`[network-id-minimisation] apply requested — refused for every field; nothing written. ${NETWORK_IDENTIFIER_FIELDS.length} field(s) counted.`);
  return out;
}
