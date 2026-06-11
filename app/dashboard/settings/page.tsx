import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { SettingsClient } from "@/components/dashboard/SettingsClient";

export default async function SettingsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const user = await db.user.findUnique({
    where:  { id: session.user.id },
    select: {
      email:            true,
      username:         true,
      firstName:        true,
      lastName:         true,
      employmentStatus: true,
      useCase:          true,
      dateOfBirthEncrypted: true,
    },
  });

  if (!user) redirect("/login");

  return (
    <SettingsClient
      initialProfile={{
        email:            user.email,
        username:         user.username         ?? "",
        firstName:        user.firstName        ?? "",
        lastName:         user.lastName         ?? "",
        employmentStatus: user.employmentStatus ?? "",
        useCase:          user.useCase          ?? "",
        hasDob:           !!user.dateOfBirthEncrypted,
      }}
    />
  );
}
