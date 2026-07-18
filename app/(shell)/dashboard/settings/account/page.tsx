import { getAccount } from "@/lib/settings/loaders";
import { AccountSettings } from "@/components/settings/AccountSettings";

export default async function AccountSettingsPage() {
  const account = await getAccount();

  return (
    <div className="max-w-2xl mx-auto space-y-6 px-4 pb-6">
      <AccountSettings account={account} />
    </div>
  );
}
