import { getDataPrivacy } from "@/lib/settings/loaders";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { DataPrivacySettings } from "@/components/settings/DataPrivacySettings";

export default async function DataPrivacySettingsPage() {
  await getDataPrivacy();

  return (
    <div className="max-w-2xl mx-auto space-y-6 px-4 py-6">
      <SettingsPageHeader title="Data & Privacy" subtitle="Export, archive, and privacy tools." />
      <DataPrivacySettings />
    </div>
  );
}
