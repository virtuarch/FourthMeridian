import { redirect } from "next/navigation";

// The Workspaces page has been redesigned and moved to /dashboard/spaces as
// part of the Fourth Meridian "Spaces" rename (presentation-layer only —
// the underlying /api/workspaces routes, Workspace/WorkspaceMember schema,
// and this folder's own segment name are untouched for compatibility).
// This route is kept as a permanent redirect so old links/bookmarks/back-
// button history still resolve.
export default function WorkspacesPageRedirect() {
  redirect("/dashboard/spaces");
}
