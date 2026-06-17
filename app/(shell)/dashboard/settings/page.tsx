import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { SettingsClient } from "@/components/dashboard/SettingsClient";

export default async function SettingsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const [user, memberships] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).user.findUnique({
      where:  { id: session.user.id },
      select: {
        email:                true,
        username:             true,
        firstName:            true,
        lastName:             true,
        employmentStatus:     true,
        useCase:              true,
        dateOfBirthEncrypted: true,
        preferredWorkspaceId: true,
      },
    }) as Promise<{
      email: string; username: string | null; firstName: string | null;
      lastName: string | null; employmentStatus: string | null; useCase: string | null;
      dateOfBirthEncrypted: string | null; preferredWorkspaceId: string | null;
    } | null>,
    db.workspaceMember.findMany({
      // Archived/trashed workspaces can't be set as the default landing
      // workspace — exclude them from this picker.
      where:   { userId: session.user.id, status: "ACTIVE", workspace: { archivedAt: null, deletedAt: null } },
      include: { workspace: { select: { id: true, name: true, type: true } } },
      orderBy: { joinedAt: "asc" },
    }),
  ]);

  if (!user) redirect("/login");

  const workspaces = memberships.map((m) => ({
    id:   m.workspace.id,
    name: m.workspace.name,
    type: m.workspace.type,
  }));

  return (
    <SettingsClient
      initialProfile={{
        email:                user.email,
        username:             user.username             ?? "",
        firstName:            user.firstName            ?? "",
        lastName:             user.lastName             ?? "",
        employmentStatus:     user.employmentStatus     ?? "",
        useCase:              user.useCase              ?? "",
        hasDob:               !!user.dateOfBirthEncrypted,
        preferredWorkspaceId: user.preferredWorkspaceId ?? null,
      }}
      workspaces={workspaces}
    />
  );
}
