/**
 * lib/assets/valuations.test.ts   (RWA-2A)
 *
 * The valuation ledger's writer and reader against an in-memory tenant client:
 *   - append-only: every write CREATES; nothing is updated or deleted,
 *   - a legacy asset's balance is preserved as its first entry, not erased,
 *   - a backdated correction never displaces the latest valuation,
 *   - same-day correction: the later entry wins, the earlier is kept,
 *   - the read serves the OWNER or a FULL-link viewer only (BALANCE_ONLY → 404),
 * plus source pins on the migration (append-only by GRANT) and the routes.
 *
 *   npx tsx lib/assets/valuations.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TenantClient } from "@/lib/db/tenant-context";
import { appendValuation, loadValuationHistory, recordInitialValuation } from "./valuations";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const code = (...p: string[]) => read(...p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── In-memory tenant client (only what lib/assets/valuations.ts touches) ──────
type Row = { id: string; financialAccountId: string; effectiveDate: Date; value: number; currency: string; recordedAt: Date; recordedByUserId: string | null };
function fakeTx(opts: {
  account: { id: string; ownerUserId: string; syncStatus: string; deletedAt: Date | null; currency: string; balance: number; lastUpdated: Date };
  fullLinkVisible: boolean;
}) {
  const rows: Row[] = [];
  const profiles: Record<string, unknown>[] = [];
  const ops: string[] = [];
  let seq = 0, clock = Date.parse("2026-10-15T10:00:00Z");
  const tx = {
    assetValuation: {
      count: async ({ where }: { where: { financialAccountId: string } }) => rows.filter((r) => r.financialAccountId === where.financialAccountId).length,
      create: async ({ data }: { data: Partial<Row> & { financialAccountId: string; effectiveDate: Date; value: number; currency: string } }) => {
        ops.push("create");
        const r: Row = { id: `v${++seq}`, recordedByUserId: null, ...data, recordedAt: data.recordedAt ?? new Date(clock += 1000) } as Row;
        rows.push(r); return r;
      },
      update: async () => { ops.push("update"); throw new Error("append-only"); },
      delete: async () => { ops.push("delete"); throw new Error("append-only"); },
      findMany: async ({ where }: { where: { financialAccountId: string | { in: string[] } } }) => {
        const ids = typeof where.financialAccountId === "string" ? [where.financialAccountId] : where.financialAccountId.in;
        return rows.filter((r) => ids.includes(r.financialAccountId))
          .sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime() || a.recordedAt.getTime() - b.recordedAt.getTime());
      },
    },
    manualAssetProfile: {
      create: async ({ data }: { data: Record<string, unknown> }) => { profiles.push(data); return data; },
      findUnique: async ({ where }: { where: { financialAccountId: string } }) =>
        (profiles.find((p) => p.financialAccountId === where.financialAccountId) as never) ?? null,
      findMany: async () => profiles,
    },
    financialAccount: { findUnique: async () => opts.account },
    spaceAccountLink: {
      findFirst: async ({ where }: { where: { visibilityLevel: string } }) =>
        where.visibilityLevel === "FULL" && opts.fullLinkVisible ? { id: "sal" } : null,
    },
  };
  return { tx: tx as unknown as TenantClient, rows, ops };
}
const acct = (over: Partial<Parameters<typeof fakeTx>[0]["account"]> = {}) => ({
  id: "house", ownerUserId: "owner", syncStatus: "manual", deletedAt: null, currency: "USD",
  balance: 480_000, lastUpdated: new Date("2026-05-01T09:00:00Z"), ...over,
});
const TODAY = "2026-10-15";

async function main() {
  console.log("appendValuation — legacy preserved, append-only, latest wins");
  {
    const { tx, rows, ops } = fakeTx({ account: acct(), fullLinkVisible: true });
    const r1 = await appendValuation(tx, { financialAccountId: "house", userId: "owner", value: 500_000, currency: "USD",
      effectiveDate: TODAY, legacy: { balance: 480_000, lastUpdated: new Date("2026-05-01T09:00:00Z") } });
    check("a legacy asset's balance is written FIRST as what it was (dated at lastUpdated)",
      rows.length === 2 && rows[0].value === 480_000 && rows[0].effectiveDate.toISOString().startsWith("2026-05-01") && rows[0].recordedByUserId === null);
    check("…then the new valuation", rows[1].value === 500_000 && rows[1].recordedByUserId === "owner");
    check("latest anchor = the new value", r1.latest.value === 500_000 && r1.latest.date === TODAY);

    const r2 = await appendValuation(tx, { financialAccountId: "house", userId: "owner", value: 470_000, currency: "USD",
      effectiveDate: "2026-08-01", legacy: { balance: 500_000, lastUpdated: new Date() } });
    check("a backdated correction is appended, and does NOT displace the latest", rows.length === 3 && r2.latest.value === 500_000);

    const r3 = await appendValuation(tx, { financialAccountId: "house", userId: "owner", value: 505_000, currency: "USD",
      effectiveDate: TODAY, legacy: { balance: 500_000, lastUpdated: new Date() } });
    check("a same-day correction is a NEW row that wins its date", rows.length === 4 && r3.latest.value === 505_000);
    check("nothing was ever updated or deleted", ops.every((o) => o === "create"), ops.join());
  }

  console.log("recordInitialValuation — profile only when facts were given");
  {
    const { tx, rows } = fakeTx({ account: acct(), fullLinkVisible: true });
    await recordInitialValuation(tx, { financialAccountId: "house", userId: "owner", value: 1, currency: "USD", effectiveDate: TODAY });
    const prof = await (tx as unknown as { manualAssetProfile: { findUnique: (a: unknown) => Promise<unknown> } })
      .manualAssetProfile.findUnique({ where: { financialAccountId: "house" } });
    check("no facts → no profile row, one valuation", prof === null && rows.length === 1);
    const t2 = fakeTx({ account: acct(), fullLinkVisible: true });
    await recordInitialValuation(t2.tx, { financialAccountId: "house", userId: "owner", value: 500_000, currency: "USD", effectiveDate: TODAY,
      acquisition: { acquisitionDate: "2020-10-15", purchasePrice: 400_000, purchasePriceIsStartingValue: true } });
    const h = await loadValuationHistory(t2.tx, { financialAccountId: "house", viewerUserId: "owner", today: TODAY });
    check("opt-in purchase price becomes the first anchor at read time (never a ledger row)",
      h.kind === "ok" && h.history.resolved.anchors[0]?.kind === "PURCHASE_PRICE" && t2.rows.length === 1);
    check("…and the history between is modeled", h.kind === "ok" && h.history.series.some((p) => p.basis === "modeled"));
  }

  console.log("loadValuationHistory — owner or FULL viewer only");
  {
    const owner = await loadValuationHistory(fakeTx({ account: acct(), fullLinkVisible: false }).tx, { financialAccountId: "house", viewerUserId: "owner", today: TODAY });
    check("owner reads", owner.kind === "ok");
    const full = await loadValuationHistory(fakeTx({ account: acct(), fullLinkVisible: true }).tx, { financialAccountId: "house", viewerUserId: "member", today: TODAY });
    check("a FULL-link member reads", full.kind === "ok");
    const balOnly = await loadValuationHistory(fakeTx({ account: acct(), fullLinkVisible: false }).tx, { financialAccountId: "house", viewerUserId: "member", today: TODAY });
    check("a BALANCE_ONLY (or no-FULL) viewer is refused", balOnly.kind === "forbidden");
    const plaid = await loadValuationHistory(fakeTx({ account: acct({ syncStatus: "synced" }), fullLinkVisible: true }).tx, { financialAccountId: "house", viewerUserId: "owner", today: TODAY });
    check("a non-manual account has no valuation history", plaid.kind === "forbidden");
    const archived = await loadValuationHistory(fakeTx({ account: acct({ deletedAt: new Date() }), fullLinkVisible: true }).tx, { financialAccountId: "house", viewerUserId: "owner", today: TODAY });
    check("an archived asset is not served", archived.kind === "forbidden");
  }

  console.log("migration — append-only by GRANT, RLS forced");
  {
    const SQL = read("prisma", "migrations", "20261015120000_rls_asset_valuations", "migration.sql");
    check("fm_app gets SELECT, INSERT on AssetValuation — and nothing else",
      /GRANT SELECT, INSERT ON TABLE public\."AssetValuation" TO fm_app;/.test(SQL) &&
      !/GRANT[^;]*(UPDATE|DELETE)[^;]*"AssetValuation"[^;]*TO fm_app/.test(SQL));
    check("no fm_app UPDATE/DELETE policy on AssetValuation",
      !/fm_app_upd ON public\."AssetValuation"/.test(SQL) && !/fm_app_del ON public\."AssetValuation"/.test(SQL));
    check("both tables ENABLE + FORCE RLS", /ENABLE ROW LEVEL SECURITY/.test(SQL) && /FORCE ROW LEVEL SECURITY/.test(SQL) && /ARRAY\['ManualAssetProfile', 'AssetValuation'\]/.test(SQL));
    check("value is non-negative and finite at the database", /CHECK \("value" >= 0 AND "value" < 'Infinity'::double precision\)/.test(SQL));
    check("recorder deletion never deletes a valuation (SET NULL)", /"AssetValuation_recordedByUserId_fkey"[\s\S]*ON DELETE SET NULL/.test(SQL));
  }

  console.log("routes — one helper call each, dated, validated; no financial values in new audit metadata");
  {
    const POST = code("app", "api", "accounts", "manual", "route.ts");
    check("POST writes the first valuation inside its transaction", POST.includes("await recordInitialValuation(tx, {"));
    check("POST validates acquisition + valuation dates with the shared rules", POST.includes("checkAcquisitionDate(") && POST.includes("checkEffectiveDate("));
    const PATCH = code("app", "api", "accounts", "manual", "[id]", "route.ts");
    check("PATCH appends (never overwrites) and the balance follows the latest-dated anchor",
      PATCH.includes("await appendValuation(tx, {") && PATCH.includes("balance: latest.value"));
    check("PATCH validates the effective date (future / before acquisition refused)", PATCH.includes("checkEffectiveDate(effectiveDate, today,"));
    const GET = code("app", "api", "accounts", "manual", "[id]", "valuations", "route.ts");
    check("history read goes through the owner-or-FULL gate", GET.includes("loadValuationHistory(tx,") && GET.includes('"forbidden"'));
    const VAL = code("lib", "assets", "valuations.ts");
    check("the ledger module never updates or deletes a valuation",
      !/assetValuation\.(update|updateMany|delete|deleteMany|upsert)\(/.test(VAL));
    check("the ledger module writes no audit rows (routes own audit; no financial values)", !/auditLog/.test(VAL));
  }

  if (failures > 0) {
    console.error(`\nvaluations: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nvaluations: all passed.");
}

void main();
