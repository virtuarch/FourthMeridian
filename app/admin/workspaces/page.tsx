import { redirect } from "next/navigation";

// The admin Workspaces page has been redesigned and moved to /admin/spaces
// as part of the Fourth Meridian "Spaces" rename (presentation-layer only —
// this folder's own segment name is kept as a permanent redirect so old
// links/bookmarks/back-button history still resolve). The underlying
// /api/admin/spaces route and the Space/SpaceMember Prisma models (renamed
// via @@map — no DDL) power this page now.
export default function AdminWorkspacesPageRedirect() {
  redirect("/admin/spaces");
}
