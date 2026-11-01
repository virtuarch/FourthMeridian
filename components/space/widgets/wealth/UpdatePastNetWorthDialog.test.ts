/**
 * components/space/widgets/wealth/UpdatePastNetWorthDialog.test.ts   (RWA-2B)
 *
 * The consent flow for "Update past net worth?":
 *   - the OFFER gate (RealAssetsSection.resolveAmendmentOffer, executable):
 *     PERSONAL shows when an anchor precedes today; SHARED / unknown never — and
 *     never even reads the ledger; nothing when no history precedes today;
 *   - CONSENT IS REQUIRED FOR WRITES, end to end (source pins): the dialog
 *     previews with `preview: true` on open and sends `consent: true` only from
 *     the explicit confirm handler over the CLIPPED range; the amend route
 *     applies only under `body.consent === true`; the library's preview runs
 *     the engine as a dry run, and the engine writes nothing on a dry run;
 *   - the dialog's copy never calls a modeled day observed.
 *
 *   npx tsx components/space/widgets/wealth/UpdatePastNetWorthDialog.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAmendmentOffer } from "./RealAssetsSection";
import { HISTORICAL_AMENDMENT_ENABLED } from "@/lib/snapshots/amendment-availability";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const code = (...p: string[]) => read(...p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const TODAY = "2026-10-15";

async function main(): Promise<void> {
  console.log("1. the offer gate — personal shows, shared never, nothing without history before today");
  {
    let reads = 0;
    const history = (anchors: { date: string }[]) => async () => { reads++; return { anchors }; };

    const personal = await resolveAmendmentOffer({ spaceType: "PERSONAL", accountId: "a1", today: TODAY, fetchHistory: history([{ date: "2026-01-01" }, { date: TODAY }]) });
    // F1 (owner ruling 2026-10-15): while the amendment action is disabled the
    // offer is null even on the personal path; the range pin applies once it is ON.
    check("PERSONAL + a backdated anchor → offered over [first anchor, yesterday] (null while the F1 switch is OFF)",
      HISTORICAL_AMENDMENT_ENABLED
        ? JSON.stringify(personal) === JSON.stringify({ fromDate: "2026-01-01", toDate: "2026-10-14" })
        : personal === null);

    reads = 0;
    const shared = await resolveAmendmentOffer({ spaceType: "SHARED", accountId: "a1", today: TODAY, fetchHistory: history([{ date: "2026-01-01" }]) });
    check("SHARED → never offered", shared === null);
    check("…and the ledger is not even read (fail closed before any fetch)", reads === 0);
    const unknown = await resolveAmendmentOffer({ spaceType: undefined, accountId: "a1", today: TODAY, fetchHistory: history([{ date: "2026-01-01" }]) });
    check("unknown Space type → never offered, no read", unknown === null && reads === 0);

    const fresh = await resolveAmendmentOffer({ spaceType: "PERSONAL", accountId: "a1", today: TODAY, fetchHistory: history([{ date: TODAY }]) });
    check("an asset first valued today → no history before today → no offer", fresh === null);
    const unreadable = await resolveAmendmentOffer({ spaceType: "PERSONAL", accountId: "a1", today: TODAY, fetchHistory: async () => null });
    check("a failed history read → no offer (never guess)", unreadable === null);
  }

  console.log("2. consent is required for writes — the dialog");
  {
    const DIALOG = code("components", "space", "widgets", "wealth", "UpdatePastNetWorthDialog.tsx");
    check("previews first: the mount effect POSTs { preview: true } over the offered range",
      /useEffect\(\(\) => \{[\s\S]*?fromDate: offer\.fromDate, toDate: offer\.toDate, preview: true \}/.test(DIALOG));
    check("consent: true appears exactly once — inside the explicit confirm handler",
      (DIALOG.match(/consent: true/g) ?? []).length === 1 && /async function confirm\(clipped: ClippedPreview\) \{[\s\S]*?consent: true/.test(DIALOG));
    check("the consented write uses the CLIPPED range, never the raw offer",
      /fromDate: clipped\.fromDate, toDate: clipped\.toDate, consent: true/.test(DIALOG));
    const effectBlock = DIALOG.match(/useEffect\(\(\) => \{([\s\S]*?)\}, \[spaceId, accountId, offer\]\);/)?.[1] ?? "";
    check("confirm is reachable only from the confirm button's onClick (never auto-applied)",
      (DIALOG.match(/confirm\(ready\)/g) ?? []).length === 1 && /onClick=\{\(\) => \{ if \(ready\) void confirm\(ready\); \}\}/.test(DIALOG)
        && effectBlock.length > 0 && !/\bconfirm\(/.test(effectBlock) && !/consent/.test(effectBlock));
    check("the preview is clipped to the Space's existing history through the pure core",
      /clipAmendmentPreview\(\(data\.days \?\? \[\]\) as PreviewDay\[\], offer\)/.test(DIALOG));
    check("the user sees the affected range and before → after net worth before confirming",
      DIALOG.includes("data-amendment-preview") && /formatCurrencyWhole\(ready\.netWorthBefore, currency\)/.test(DIALOG)
        && /formatCurrencyWhole\(ready\.netWorthAfter, currency\)/.test(DIALOG) && /formatDate\(ready\.firstChanged\)/.test(DIALOG));
    check("a cancel path exists that keeps history as recorded", DIALOG.includes("Keep history as recorded"));
    check("uses the existing amendment kind (no new kind, no new write path)",
      DIALOG.includes('REAL_ASSET_AMENDMENT_KIND = "ACCOUNT_ADDED_RETROACTIVE"') && !/\/api\/snapshots|\/api\/spaces\/[^"'`]*\/(regenerate|rebuild)/.test(DIALOG));
    const RAW = read("components", "space", "widgets", "wealth", "UpdatePastNetWorthDialog.tsx");
    check("modeled days are described as modeled, never observed",
      RAW.includes("MODELED_HISTORY_MEANING") && RAW.includes("shown as modeled, not observed") && !/as observed\b/.test(RAW.replace("not observed", "")));
  }

  console.log("3. consent is required for writes — the route, the library, the engine");
  {
    const ROUTE = code("app", "api", "spaces", "[id]", "wealth", "amend", "route.ts");
    check("the route applies ONLY under body.consent === true; every other call previews",
      // (BETA LIFECYCLE L2 — the billable gate sits between the consent check and the apply.)
      /if \(body\.consent === true\) \{[\s\S]{0,600}?const result = await applyAmendment\(request\);/.test(ROUTE)
        && (ROUTE.match(/applyAmendment\(/g) ?? []).length === 1
        && /const preview = await previewAmendment\(request\);/.test(ROUTE));
    check("the route is OWNER-gated on the Space (requireSpaceRole OWNER)", /requireSpaceRole\(id, SpaceMemberRole\.OWNER\)/.test(ROUTE));
    const LIB = code("lib", "snapshots", "snapshot-amendment.ts");
    check("previewAmendment runs the engine as a DRY RUN", /export async function previewAmendment[\s\S]*?dryRun: true/.test(LIB));
    check("applyAmendment is the only path that stamps rows (amendedByAmendmentId)",
      /export async function applyAmendment[\s\S]*?amendedByAmendmentId: amendment\.id/.test(LIB)
        && !/export async function previewAmendment[\s\S]*?amendedByAmendmentId[\s\S]*?export async function applyAmendment/.test(LIB));
    check("the library still refuses a SHARED Space before the engine is reached",
      /if \(space\.type !== SpaceType\.PERSONAL\) throw new SharedSpaceAmendmentError\(\);/.test(LIB));
    const ENGINE = code("lib", "snapshots", "regenerate-history.ts");
    check("the engine writes nothing on a dry run (applyWrites requires !dryRun)",
      /const applyWrites = !args\.dryRun && \(wealthRegenerationEnabled\(\) \|\| args\.isAmendment === true\);/.test(ENGINE));
    check("automatic (non-amendment) writes stay behind WEALTH_REGENERATION_ENABLED", /wealthRegenerationEnabled\(\)/.test(ENGINE));
  }

  console.log("4. the entry points");
  {
    const SECTION = code("components", "space", "widgets", "wealth", "RealAssetsSection.tsx");
    check("the section offers after Add and after Update value, through ONE path (afterWrite → resolveAmendmentOffer)",
      /onAdd=\{\(created\) => afterWrite\(\{ accountId: created\.accountId, name: created\.name, currency: created\.currency \}\)\}/.test(SECTION)
        && /onSaved=\{\(saved\) => afterWrite\(\{ accountId: saved\.accountId/.test(SECTION)
        && /void resolveAmendmentOffer\(\{ spaceType, accountId: written\.accountId/.test(SECTION));
    check("the dialog is mounted only while an offer is pending", /\{pendingOffer && \(\s*<UpdatePastNetWorthDialog/.test(SECTION));
    check("the section never calls the amend route itself (the dialog owns preview + consent)", !SECTION.includes("/wealth/amend"));
    const ADD = code("components", "dashboard", "AddManualAssetModal.tsx");
    check("Add reports the created account id, name and currency (the POST response carries them)",
      /onAdd\?\.\(\{ accountId: String\(data\.accountId \?\? ""\), name: String\(data\.name \?\? name\.trim\(\)\), currency: String\(data\.currency \?\? currency\) \}\)/.test(ADD));
    const UPDATE = code("components", "space", "widgets", "wealth", "UpdateAssetValueModal.tsx");
    check("Update value reports the account and the effective date", /onSaved\(\{ accountId, effectiveDate: asOf \}\)/.test(UPDATE));
    const WEALTH = code("components", "space", "widgets", "wealth", "WealthWorkspace.tsx");
    const RENDER = code("components", "space", "workspaces", "workspaceRenderers.tsx");
    const HOST   = code("components", "dashboard", "SpaceDashboard.tsx");
    check("spaceType reaches the section from the host (display gate only; the server decides)",
      /<RealAssetsSection spaceId=\{spaceId\} spaceType=\{spaceType\}/.test(WEALTH)
        && /spaceType=\{ctx\.spaceType\}/.test(RENDER)
        && /const renderCtx: WorkspaceRenderCtx = \{\s*spaceId,\s*spaceType,/.test(HOST));
  }

  if (failures > 0) { console.error(`\nUpdatePastNetWorthDialog: ${failures} failure(s).`); process.exit(1); }
  console.log("\nUpdatePastNetWorthDialog: all passed.");
  process.exit(0);
}

main();
