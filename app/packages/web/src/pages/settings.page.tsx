import { WatchdogPanel } from '../components/watchdog-panel.component.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';

/**
 * Settings route (`/settings`) — watchdog config + general settings skeleton.
 * Per the issue spec, the watchdog panel moves here from the dashboard.
 */
export function SettingsPage() {
  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-semibold">Settings</h2>
        <PollingIndicator />
      </div>

      {/* Watchdog section */}
      <div className="mb-8">
        <h3 className="text-lg font-medium mb-4">Watchdog Configuration</h3>
        <WatchdogPanel />
      </div>

      {/* General settings placeholder */}
      <div>
        <h3 className="text-lg font-medium mb-4">General</h3>
        <p className="text-muted-foreground text-sm">
          Additional configuration options will appear here in future updates.
        </p>
      </div>
    </div>
  );
}
