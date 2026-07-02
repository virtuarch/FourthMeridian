import { redirect } from "next/navigation";

// The Workspaces page has been redesigned and moved to /dashboard/spaces as
// part of the Fourth Meridian "Spaces" rename. This folder's own segment
// name (/dashboard/workspaces) is kept as a permanent redirect so old
// links/bookmarks/back-button history still resolve — everything underneath
// it has since moved: the API routes now live at /api/spaces, and the
// Prisma models are now Space/SpaceMember (renamed via @@map — no DDL,
// same underlying tables).
export default function WorkspacesPageRedirect() {
  redirect("/dashboard/spaces");
}
