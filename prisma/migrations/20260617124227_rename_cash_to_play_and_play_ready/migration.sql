-- Rename WorkspaceSnapshot.cashToPlay -> cashOnHand
-- Pure rename (no data movement, no nullability/default change). "cashToPlay"
-- carried over from early "play cash" language for discretionary investing
-- capital; the UI card has long been titled "Cash on Hand" and the value it
-- represents is liquid cash available, not discretionary/play money. No
-- unique index touches this column, so no index rename is required.
ALTER TABLE "WorkspaceSnapshot" RENAME COLUMN "cashToPlay" TO "cashOnHand";

-- Rename AiAdvice.playReady -> actionReady
-- Pure rename (no data movement, no nullability/default change). Same "play"
-- metaphor family as cashToPlay, replaced for the same reason. No unique
-- index touches this column.
ALTER TABLE "AiAdvice" RENAME COLUMN "playReady" TO "actionReady";
