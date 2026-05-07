import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { setUnauthorizedHandler } from './api.service.js';
import { ApiTokenModal } from './components/api-token-modal.component.js';
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
 * Root component. Wires up the 401 handler on `api.ts` and renders the routed
 * dashboard shell with the API token dialog overlaid when an `/api/*` request
 * has been parked on a 401. Five routes:
 *   - `/` → Dashboard (game cards + panels)
 *   - `/costs` → Cost analysis placeholder
 *   - `/discord` → Discord settings placeholder
 *   - `/logs` → Logs placeholder
 *   - `/settings` → Watchdog + general settings
 */
export default function App() {
  // Open the token modal only once the API actually rejects us with a 401.
  // In dev mode the server allows unauthenticated requests when no API_TOKEN
  // is configured, so defaulting to "needs token" would block local iteration
  // for no reason. The first failing /api request will flip this flag.
  const [needsToken, setNeedsToken] = useState(false);
  useEffect(() => {
    setUnauthorizedHandler(() => setNeedsToken(true));
    return () => setUnauthorizedHandler(null);
  }, []);

  return (
    <PollingProvider>
      <GameStatusProvider>
        <BrowserRouter>
          <Toaster position="bottom-right" />
          <ApiTokenModal open={needsToken} onSuccess={() => setNeedsToken(false)} />
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
