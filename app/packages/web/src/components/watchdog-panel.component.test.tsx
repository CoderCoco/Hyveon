import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WatchdogPanel } from './watchdog-panel.component.js';

const apiMock = vi.hoisted(() => ({
  config: vi.fn(),
  saveConfig: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

const toastMock = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
);
vi.mock('sonner', () => ({ toast: toastMock }));

/** Default config returned by the mocked `api.config()`. */
const DEFAULT_CONFIG = {
  watchdog_interval_minutes: 15,
  watchdog_idle_checks: 4,
  watchdog_min_packets: 100,
};

describe('WatchdogPanel', () => {
  beforeEach(() => {
    apiMock.config.mockResolvedValue(DEFAULT_CONFIG);
    apiMock.saveConfig.mockResolvedValue(undefined);
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('should render the Watchdog Settings heading', () => {
    render(<WatchdogPanel />);

    expect(screen.getByText('Watchdog Settings')).toBeInTheDocument();
  });

  it('should render the Save button', () => {
    render(<WatchdogPanel />);

    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
  });

  it('should render an accessible help button for each watchdog field', () => {
    render(<WatchdogPanel />);

    expect(screen.getByRole('button', { name: 'Check interval (min) help' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Idle checks before shutdown help' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Min packets (activity threshold) help' })).toBeInTheDocument();
  });

  it('should show a success toast after saving settings', async () => {
    render(<WatchdogPanel />);

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(toastMock.success).toHaveBeenCalledWith('Watchdog settings saved');
  });

  it('should show an error toast with the error message when saving fails', async () => {
    apiMock.saveConfig.mockRejectedValueOnce(new Error('network timeout'));
    render(<WatchdogPanel />);

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      'Failed to save watchdog settings',
      expect.objectContaining({ description: 'network timeout' }),
    );
  });

  it('should show the fallback description when saving fails with an unknown error', async () => {
    apiMock.saveConfig.mockRejectedValueOnce('not an Error object');
    render(<WatchdogPanel />);

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      'Failed to save watchdog settings',
      expect.objectContaining({ description: 'An unknown error occurred' }),
    );
  });
});
