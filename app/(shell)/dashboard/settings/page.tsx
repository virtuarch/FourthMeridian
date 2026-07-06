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
        preferredSpaceId: true,
        reportingCurrency:    true, // MC1 Phase 4 Slice 2
      },
    }) as Promise<{
      email: string; username: string | null; firstName: string | null;
      lastName: string | null; employmentStatus: string | null; useCase: string | null;
      dateOfBirthEncrypted: string | null; preferredSpaceId: string | null;
      reportingCurrency: string;
    } | null>,
    db.spaceMember.findMany({
      // Archived/trashed spaces can't be set as the default landing
      // space — exclude them from this picker.
      where:   { userId: session.user.id, status: "ACTIVE", space: { archivedAt: null, deletedAt: null } },
      include: { space: { select: { id: true, name: true, type: true } } },
      orderBy: { joinedAt: "asc" },
    }),
  ]);

  if (!user) redirect("/login");

  const spaces = memberships.map((m) => ({
    id:   m.space.id,
    name: m.space.name,
    type: m.space.type,
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
        preferredSpaceId: user.preferredSpaceId ?? null,
        reportingCurrency:    user.reportingCurrency ?? "USD", // MC1 P4 Slice 2
      }}
      spaces={spaces}
    />
  );
}
