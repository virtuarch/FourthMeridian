import { getSecurity } from "@/lib/settings/loaders";
import { SecuritySettings } from "@/components/settings/SecuritySettings";

export default async function SecuritySettingsPage() {
  const { email } = await getSecurity();

  return (
    <div className="max-w-2xl mx-auto space-y-6 px-4 pb-6">
      <SecuritySettings email={email} />
    </div>
  );
}
