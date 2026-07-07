import { getAccount } from "@/lib/settings/loaders";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { AccountSettings } from "@/components/settings/AccountSettings";

export default async function AccountSettingsPage() {
  const account = await getAccount();

  return (
    <div className="max-w-2xl mx-auto space-y-6 px-4 py-6">
      <SettingsPageHeader title="Account" subtitle="Manage your personal information." />
      <AccountSettings account={account} />
    </div>
  );
}
