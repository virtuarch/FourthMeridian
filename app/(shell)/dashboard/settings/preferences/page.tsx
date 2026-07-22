import { getPreferences } from "@/lib/settings/loaders";
import { PreferencesSettings } from "@/components/settings/PreferencesSettings";

export default async function PreferencesSettingsPage() {
  const preferences = await getPreferences();

  return (
    <div className="max-w-2xl mx-auto space-y-6 px-4 pb-6">
      <PreferencesSettings preferences={preferences} />
    </div>
  );
}
