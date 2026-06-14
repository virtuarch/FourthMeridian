-- Add seenAt to WorkspaceInvite
-- NULL = unseen (drives sidebar badge count); non-null = user has viewed the invite

ALTER TABLE "WorkspaceInvite" ADD COLUMN "seenAt" TIMESTAMP(3);
