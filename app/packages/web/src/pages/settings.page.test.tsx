import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  costsEstimate: vi.fn(),
  config: vi.fn(),
  saveConfig: vi.fn(),
  diagnosticsTail: vi.fn(),
  diagnosticsLogPath: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));
vi.mock('../components/DiagnosticsPanel.js', () => ({
  DiagnosticsPanel: () => <div data-testid="diagnostics-panel">DiagnosticsPanel</div>,
}));

import { SettingsPage } from './settings.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

describe('SettingsPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    apiMock.config.mockResolvedValue({
      watchdog_interval_minutes: 15,
      watchdog_idle_checks: 4,
      watchdog_min_packets: 100,
    });
  });

  it('should render the Settings heading', () => {
    renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });

  it('should render the Watchdog Configuration section', () => {
    renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
    expect(screen.getByRole('heading', { name: 'Watchdog Configuration' })).toBeInTheDocument();
  });

  it('should render the polling indicator once the status poll resolves', async () => {
    renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
    expect(await screen.findByText(/^Updated\b/)).toBeInTheDocument();
  });

  it('should render the Diagnostics section heading', () => {
    renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
    expect(screen.getByRole('heading', { name: 'Diagnostics' })).toBeInTheDocument();
  });

  it('should render the DiagnosticsPanel inside the Diagnostics section', () => {
    renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
    expect(screen.getByTestId('diagnostics-panel')).toBeInTheDocument();
  });
});
