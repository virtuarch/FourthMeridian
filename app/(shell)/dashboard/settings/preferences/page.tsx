import { getPreferences } from "@/lib/settings/loaders";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { PreferencesSettings } from "@/components/settings/PreferencesSettings";

export default async function PreferencesSettingsPage() {
  const preferences = await getPreferences();

  return (
    <div className="max-w-2xl mx-auto space-y-6 px-4 py-6">
      <SettingsPageHeader title="Preferences" subtitle="Reporting currency and personal defaults." />
      <PreferencesSettings preferences={preferences} />
    </div>
  );
}
