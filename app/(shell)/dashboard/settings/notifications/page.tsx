/**
 * /dashboard/settings/notifications  (OPS-3 S3)
 *
 * The Notifications settings page — arrives WITH OPS-3 per UX-1 Phase 2 §5
 * (no placeholder existed before this slice). Thin server component in the
 * per-page-loader architecture: call the loader, pass typed props to the
 * client component.
 */

import { getNotificationPreferences } from "@/lib/settings/loaders";
import { NotificationSettings } from "@/components/settings/NotificationSettings";

export default async function NotificationSettingsPage() {
  const matrix = await getNotificationPreferences();

  return (
    <div className="max-w-2xl mx-auto space-y-6 px-4 pb-6">
      <NotificationSettings matrix={matrix} />
    </div>
  );
}
