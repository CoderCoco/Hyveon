import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppLayout } from './components/app-layout.component.js';
import { DashboardPage } from './pages/dashboard.page.js';
import { CostsPage } from './pages/costs.page.js';
import { DiscordPage } from './pages/discord.page.js';
import { LogsPage } from './pages/logs.page.js';
import { SettingsPage } from './pages/settings.page.js';
import { PollingProvider } from './polling/polling-provider.component.js';
import { GameStatusProvider } from './polling/game-status-provider.component.js';
import { Toaster } from './components/ui/sonner.component.js';

/**
 * Root component. Renders the routed dashboard shell. Five routes:
 *   - `/` → Dashboard (game cards + panels)
 *   - `/costs` → Cost analysis placeholder
 *   - `/discord` → Discord settings placeholder
 *   - `/logs` → Logs placeholder
 *   - `/settings` → Watchdog + general settings
 */
export default function App() {
  return (
    <PollingProvider>
      <GameStatusProvider>
        <BrowserRouter>
          <Toaster position="bottom-right" />
          <AppLayout>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/costs" element={<CostsPage />} />
              <Route path="/discord" element={<DiscordPage />} />
              <Route path="/logs" element={<LogsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </AppLayout>
        </BrowserRouter>
      </GameStatusProvider>
    </PollingProvider>
  );
}
