/**
 * scripts/lib/migration-names.ts — DB-008, migration directory naming (pure).
 *
 * Prisma applies prisma/migrations/* in LEXICAL order of the directory name
 * and records the name in _prisma_migrations. Two things make that fragile
 * here: fifteen-plus migrations from 2026-07-22 to 2026-08-18 were named with
 * a DATE ONLY (`20260724_df2a_refresh_execution`), so three migrations on one
 * day sort by their slug rather than by when they were written; and nothing
 * stopped the next author from doing the same, or from choosing a timestamp
 * EARLIER than the newest applied migration (which `migrate deploy` then
 * applies out of history order on every environment that already passed it).
 *
 * The rule, from here on:
 *   · every migration directory is `<14-digit UTC timestamp>_<slug>`, the
 *     timestamp a real calendar instant (YYYYMMDDHHMMSS);
 *   · timestamps are unique;
 *   · a timestamped name sorts AFTER every legacy date-only name that
 *     precedes it in the tree — i.e. the sequence is monotone in directory
 *     order, with legacy names compared on their 8-digit date padded with
 *     zeros;
 *   · the legacy date-only names are a CLOSED allowlist (LEGACY_DATE_ONLY):
 *     one disappearing or a new one appearing both fail, so the exception
 *     can only shrink.
 *
 * Pure: takes the sorted list of directory names; scripts/audit-migration-names.ts
 * reads the filesystem, scripts/audit-migration-names.test.ts feeds fixtures.
 */

/** The date-only legacy names present on 2026-10-22, exactly. */
export const LEGACY_DATE_ONLY: readonly string[] = [
  "20260722_plaid_sync_imported_count",
  "20260723_plaid_completed_sync_count",
  "20260723_plaid_history_build_progress",
  "20260724_df2a_refresh_execution",
  "20260724_df2d_provider_call",
  "20260724_df2e_account_coverage",
  "20260725_ops2b_deployment_identity",
  "20260725_ops2d2_platform_control_capability",
  "20260725_ops2d3_admission_reason",
  "20260726_ops2d5a1_sync_incident_lifecycle",
  "20260727_ops2d5b1_persistence_taxonomy",
  "20260727_v26pre_b4_btc_identity_backstop",
  "20260801_v26_investments_history_snapshot_completeness",
  "20260801_v26_quantity_1e_investment_event_coverage",
  "20260801_v26_quantity_1h_coverage_history_floor",
  "20260803_v26_crypto_valuation_status",
  "20260803_v26_provider_capability_observation",
  "20260804_v26_historical_stage_split",
  "20260804_v26_s1_corporate_action_terms",
  "20260805_l8_event_identity",
  "20260805_l8a_economic_date_column",
  "20260805_l8b1_event_current_projection",
  "20260806_v26_own1_flow_authority",
  "20260818_w1_observation_link_evidence",
];

export const TIMESTAMPED = /^(\d{14})_[a-z0-9][a-z0-9_]*$/;
const DATE_ONLY = /^(\d{8})_[a-z0-9][a-z0-9_]*$/;

/** True when a 14-digit string is a real UTC calendar instant. */
export function isCalendarTimestamp(ts: string): boolean {
  if (!/^\d{14}$/.test(ts)) return false;
  const y = +ts.slice(0, 4), mo = +ts.slice(4, 6), d = +ts.slice(6, 8);
  const h = +ts.slice(8, 10), mi = +ts.slice(10, 12), s = +ts.slice(12, 14);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export interface MigrationNameReport {
  total: number;
  timestamped: number;
  legacy: number;
  errors: string[];
}

/** The ordering key: a timestamp as-is; a legacy date padded to 14 digits. */
function orderKey(name: string): string | null {
  const t = TIMESTAMPED.exec(name);
  if (t) return t[1];
  const d = DATE_ONLY.exec(name);
  if (d) return d[1] + "000000";
  return null;
}

/** `names` = the migration directory names in the order Prisma applies them (lexical). */
export function auditMigrationNames(names: readonly string[], legacy: readonly string[] = LEGACY_DATE_ONLY): MigrationNameReport {
  const report: MigrationNameReport = { total: names.length, timestamped: 0, legacy: 0, errors: [] };
  const legacySet = new Set(legacy);
  const seenTs = new Map<string, string>();
  const seenLegacy = new Set<string>();
  let prevKey = "";
  let prevName = "";

  const sorted = [...names].sort();
  if (sorted.join("\n") !== names.join("\n")) {
    report.errors.push("names were not supplied in lexical (apply) order");
  }

  for (const name of names) {
    if (legacySet.has(name)) {
      report.legacy++;
      seenLegacy.add(name);
    } else {
      const t = TIMESTAMPED.exec(name);
      if (!t) {
        report.errors.push(
          DATE_ONLY.test(name)
            ? `${name}: date-only name — new migrations must be <YYYYMMDDHHMMSS>_<slug> (the legacy date-only set is closed)`
            : `${name}: not <YYYYMMDDHHMMSS>_<lowercase_slug>`,
        );
        continue;
      }
      if (!isCalendarTimestamp(t[1])) report.errors.push(`${name}: ${t[1]} is not a real UTC calendar instant`);
      const dup = seenTs.get(t[1]);
      if (dup) report.errors.push(`${name}: timestamp ${t[1]} already used by ${dup}`);
      seenTs.set(t[1], name);
      report.timestamped++;
    }
    const key = orderKey(name);
    if (key !== null) {
      if (prevKey && key < prevKey) {
        report.errors.push(`${name}: sorts after ${prevName} on disk but its instant is earlier — the sequence must be monotone`);
      }
      if (key >= prevKey) { prevKey = key; prevName = name; }
    }
  }
  for (const l of legacy) {
    if (!seenLegacy.has(l)) report.errors.push(`${l}: in LEGACY_DATE_ONLY but no such migration directory — shrink the allowlist`);
  }
  return report;
}
