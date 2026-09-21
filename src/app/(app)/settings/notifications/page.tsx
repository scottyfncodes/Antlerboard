import { PreferencesGrid } from "@/components/notifications/PreferencesGrid";
import { PushOptIn } from "@/components/notifications/PushOptIn";
import { PageHeader } from "@/components/ui/PageHeader";

export default function NotificationSettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Notification Preferences"
        subtitle="Everything is off by default. Turn on exactly what you want to hear about, and pick the channel."
      />
      <PushOptIn vapidPublicKey={process.env.VAPID_PUBLIC_KEY || null} />
      <PreferencesGrid />
    </div>
  );
}
