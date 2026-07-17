import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DriftEntry } from '../api.service.js';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  statusGame: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  costsEstimate: vi.fn(),
  costsActual: vi.fn(),
  filesMgrStatus: vi.fn(),
  filesMgrStart: vi.fn(),
  filesMgrStop: vi.fn(),
  drift: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

import { DashboardPage } from './dashboard.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

const STATUSES = [
  { game: 'minecraft', state: 'stopped' as const },
  { game: 'valheim', state: 'running' as const, publicIp: '1.2.3.4' },
];

const ESTIMATES = {
  games: {
    minecraft: { vcpu: 1, memoryGb: 2, costPerHour: 0.08, costPerDay24h: 1.92, costPerMonth4hpd: 9.6 },
    valheim:   { vcpu: 1, memoryGb: 2, costPerHour: 0.04, costPerDay24h: 0.96, costPerMonth4hpd: 4.8 },
  },
  totalPerHourIfAllOn: 0.12,
};

describe('DashboardPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue(STATUSES);
    apiMock.costsEstimate.mockResolvedValue(ESTIMATES);
    apiMock.costsActual.mockResolvedValue({ daily: [], total: 0, currency: 'USD', days: 7 });
    apiMock.drift.mockResolvedValue({ entries: [] });
  });

  it('should show the pending changes banner when the drift report has entries', async () => {
    const entries: DriftEntry[] = [{ game: 'minecraft', kind: 'pending_create' }];
    apiMock.drift.mockResolvedValue({ entries });

    renderPage(<DashboardPage />);

    expect(await screen.findByText(/1 change pending/)).toBeInTheDocument();
  });

  it('should not show the pending changes banner when the drift report is empty', async () => {
    renderPage(<DashboardPage />);

    await screen.findByRole('heading', { name: 'minecraft' });

    expect(screen.queryByText(/change pending/)).not.toBeInTheDocument();
  });

  it('should render the polling indicator wired to the status poll alongside the search filter', async () => {
    renderPage(<DashboardPage />);

    expect(screen.getByLabelText('Filter games')).toBeInTheDocument();
    expect(await screen.findByText(/^Updated\b/)).toBeInTheDocument();
  });

  it('should render a card for every game returned by /api/status', async () => {
    renderPage(<DashboardPage />);

    expect(await screen.findByRole('heading', { name: 'minecraft' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'valheim' })).toBeInTheDocument();
  });

  it('should render the no-games card with CTAs when the server returns no statuses', async () => {
    apiMock.status.mockResolvedValue([]);
    renderPage(<DashboardPage />);

    expect(await screen.findByRole('heading', { name: 'No games deployed' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open setup guide/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /terraform\.tfvars/i })).toBeInTheDocument();
  });

  it('should narrow the visible cards by the search filter without removing the indicator', async () => {
    const user = userEvent.setup();
    renderPage(<DashboardPage />);

    await screen.findByRole('heading', { name: 'minecraft' });

    await user.type(screen.getByLabelText('Filter games'), 'valheim');

    expect(screen.queryByRole('heading', { name: 'minecraft' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'valheim' })).toBeInTheDocument();
    // The polling indicator lives next to the search input — it should survive
    // the filter typing because it reads from the persistent registry, not
    // from the filtered grid below.
    expect(screen.getByText(/^Updated\b/)).toBeInTheDocument();
  });
});
