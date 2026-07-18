"use client";

/**
 * components/space/workspaces/AccountsWorkspace.tsx
 *
 * The Accounts destination — a fixed rail tab (like Activity), now rendered in the
 * Fourth Meridian EDITORIAL idiom. It answers ONE question: "what financial objects
 * exist inside this Space?" — the ground-truth list of accounts, grouped by kind,
 * with a summary and a ledger→detail exploration (AccountsLedger).
 *
 * This is a presentation convergence: the tab used to render the shared section stack
 * (its sole section, `accounts_overview` → the collapsible AccountsPerspective card).
 * It now renders the editorial AccountsLedger directly, off the SAME data the section
 * card used (the host's shared `accounts` + the self-fetched detail read) and the SAME
 * conversion context (`card.ctx`) every section card uses. No new loader, no data-layer
 * change. `accounts_overview` remains a valid section renderer for any custom placement
 * on another tab; the Accounts RAIL TAB simply is the editorial ledger.
 *
 * PCS-2 boundary preserved: Accounts is the Space-scoped financial-object surface;
 * credential / sync / provider management stays in Connections (linked out to from the
 * detail panel), never handled here.
 */

import { AccountsLedger } from "@/components/space/widgets/accounts/AccountsLedger";
import type { SectionCardBundle } from "./SpaceSectionStack";

export function AccountsWorkspace({ card }: { card: SectionCardBundle }) {
  return (
    <AccountsLedger spaceId={card.spaceId} accounts={card.accounts} ctx={card.ctx} />
  );
}
