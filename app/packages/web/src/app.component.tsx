import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppLayout } from './components/app-layout.component.js';
import { DashboardPage } from './pages/dashboard.page.js';
import { CostsPage } from './pages/costs.page.js';
import { DiscordPage } from './pages/discord.page.js';
import { LogsPage } from './pages/logs.page.js';
import { TerraformPage } from './pages/terraform.page.js';
import { TerraformHistoryPage } from './pages/terraform-history.page.js';
import { TerraformRunDetailPage } from './pages/terraform-run-detail.page.js';
import { SettingsPage } from './pages/settings.page.js';
import { GamesPage } from './pages/games.page.js';
import { GameDetailPage } from './pages/game-detail.page.js';
import { AuditPage } from './pages/audit.page.js';
import { PollingProvider } from './polling/polling-provider.component.js';
import { GameStatusProvider } from './polling/game-status-provider.component.js';
import { Toaster } from './components/ui/sonner.component.js';

/**
 * Root component. Renders the routed dashboard shell. Routes:
 *   - `/` → Dashboard (game cards + panels)
 *   - `/costs` → Cost analysis placeholder
 *   - `/discord` → Discord settings placeholder
 *   - `/logs` → Logs placeholder
 *   - `/terraform` → Terraform plan/apply
 *   - `/terraform/history` → Terraform run history
 *   - `/terraform/history/:runId` → Read-only run detail
 *   - `/settings` → Watchdog + general settings
 *   - `/games` → Games list (read-only settings)
 *   - `/games/:name` → Per-game settings detail (read-only)
 *   - `/audit` → Audit log
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
              <Route path="/terraform" element={<TerraformPage />} />
              <Route path="/terraform/history" element={<TerraformHistoryPage />} />
              <Route path="/terraform/history/:runId" element={<TerraformRunDetailPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/games" element={<GamesPage />} />
              <Route path="/games/:name" element={<GameDetailPage />} />
              <Route path="/audit" element={<AuditPage />} />
            </Routes>
          </AppLayout>
        </BrowserRouter>
      </GameStatusProvider>
    </PollingProvider>
  );
}
