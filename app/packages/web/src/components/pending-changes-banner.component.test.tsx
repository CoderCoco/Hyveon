import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { DriftEntry, DriftReport } from '../api.service.js';
import { PendingChangesBanner } from './pending-changes-banner.component.js';

const apiMock = vi.hoisted(() => ({
  drift: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

/** A mixed drift report covering all three categories, used across most specs. */
const MIXED_ENTRIES: DriftEntry[] = [
  { game: 'minecraft', kind: 'pending_create' },
  { game: 'valheim', kind: 'pending_delete' },
  { game: 'terraria', kind: 'config_drift', changedFields: ['image'] },
  { game: 'satisfactory', kind: 'config_drift', changedFields: ['cpu', 'memory'] },
];

function mixedReport(): DriftReport {
  return { entries: MIXED_ENTRIES };
}

function emptyReport(): DriftReport {
  return { entries: [] };
}

function renderBanner() {
  return render(
    <MemoryRouter>
      <PendingChangesBanner />
    </MemoryRouter>,
  );
}

describe('PendingChangesBanner', () => {
  beforeEach(() => {
    apiMock.drift.mockReset();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
  });

  it('should render nothing when the drift report has no entries', async () => {
    apiMock.drift.mockResolvedValue(emptyReport());

    renderBanner();

    await waitFor(() => {
      expect(apiMock.drift).toHaveBeenCalledTimes(1);
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('should become visible with accurate counts per drift category', async () => {
    apiMock.drift.mockResolvedValue(mixedReport());

    renderBanner();

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('4 changes pending');
    expect(banner).toHaveTextContent('1 to create');
    expect(banner).toHaveTextContent('1 to delete');
    expect(banner).toHaveTextContent('2 to update');
  });

  it('should hide the banner after it is dismissed', async () => {
    apiMock.drift.mockResolvedValue(mixedReport());

    renderBanner();

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss pending changes banner' }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('should reappear once a subsequent poll returns a changed report', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.drift.mockResolvedValue(mixedReport());

    renderBanner();

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss pending changes banner' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // Next poll returns a report with a different set of findings — the
    // dismissal was scoped to the previous signature, so the banner should
    // come back.
    const changedEntries: DriftEntry[] = [
      ...MIXED_ENTRIES,
      { game: 'palworld', kind: 'pending_create' },
    ];
    apiMock.drift.mockResolvedValue({ entries: changedEntries });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveTextContent('5 changes pending');
  });

  it('should keep the dismissal after the component unmounts and remounts (e.g. Dashboard <-> Games navigation)', async () => {
    apiMock.drift.mockResolvedValue(mixedReport());

    const { unmount } = renderBanner();

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss pending changes banner' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // Simulate navigating away and back — the component unmounts and a
    // fresh instance mounts, but the dismissal should still be honored
    // because it's persisted in sessionStorage rather than component state.
    unmount();
    renderBanner();

    await waitFor(() => {
      expect(apiMock.drift).toHaveBeenCalledTimes(2);
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('should clear the stored dismissal once a poll returns a clean (empty) report', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.drift.mockResolvedValue(mixedReport());

    const { unmount } = renderBanner();

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss pending changes banner' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // Next poll comes back clean — the stored dismissal should be cleared,
    // not merely superseded, so the same report recurring later isn't
    // silently swallowed by a stale dismissal signature.
    apiMock.drift.mockResolvedValue(emptyReport());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    await waitFor(() => {
      expect(apiMock.drift).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // Unmount/remount (new component instance, as on navigation) and have
    // the identical mixed report recur — it should reappear because the
    // dismissal was cleared, not persisted through the empty report.
    unmount();
    apiMock.drift.mockResolvedValue(mixedReport());
    renderBanner();

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
  });

  it('should stay hidden when the drift poll fails', async () => {
    apiMock.drift.mockRejectedValue(new Error('network error'));

    renderBanner();

    await waitFor(() => {
      expect(apiMock.drift).toHaveBeenCalledTimes(1);
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
