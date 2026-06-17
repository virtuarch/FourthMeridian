-- Rename PlaidItem.plaidItemId -> PlaidItem.externalItemId
-- Pure rename (no data movement). The column still stores the same value
-- (Plaid's item_id today); the name is generalized ahead of future
-- provider abstraction. Uniqueness is preserved by renaming the existing
-- unique index rather than dropping/recreating it.

ALTER TABLE "PlaidItem" RENAME COLUMN "plaidItemId" TO "externalItemId";

ALTER INDEX "PlaidItem_plaidItemId_key" RENAME TO "PlaidItem_externalItemId_key";
