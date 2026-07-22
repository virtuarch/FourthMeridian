import { getDataPrivacy } from "@/lib/settings/loaders";
import { DataPrivacySettings } from "@/components/settings/DataPrivacySettings";

export default async function DataPrivacySettingsPage() {
  await getDataPrivacy();

  return (
    <div className="max-w-2xl mx-auto space-y-6 px-4 pb-6">
      <DataPrivacySettings />
    </div>
  );
}
