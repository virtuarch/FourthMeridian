import { getSecurity } from "@/lib/settings/loaders";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { SecuritySettings } from "@/components/settings/SecuritySettings";

export default async function SecuritySettingsPage() {
  const { email } = await getSecurity();

  return (
    <div className="max-w-2xl mx-auto space-y-6 px-4 py-6">
      <SettingsPageHeader title="Security" subtitle="Password, email, sessions, and security history." />
      <SecuritySettings email={email} />
    </div>
  );
}
