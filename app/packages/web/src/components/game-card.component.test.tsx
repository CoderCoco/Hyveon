import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { GameStatus } from '../api.service.js';
import { GameCard } from './game-card.component.js';

const apiMock = vi.hoisted(() => ({
  stop: vi.fn().mockResolvedValue(undefined),
  start: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

const mockIsSuppressed = vi.hoisted(() => vi.fn().mockReturnValue(false));
vi.mock('../lib/confirm-skip.utils.js', () => ({
  isSuppressed: mockIsSuppressed,
  suppress: vi.fn(),
}));

const toastMock = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
);
vi.mock('sonner', () => ({ toast: toastMock }));

/** A minimal running-server status fixture. */
const runningStatus: GameStatus = {
  game: 'minecraft',
  state: 'running',
};

/** A minimal stopped-server status fixture. */
const stoppedStatus: GameStatus = {
  game: 'minecraft',
  state: 'stopped',
};

function renderCard(status: GameStatus = runningStatus) {
  return render(
    <MemoryRouter>
      <GameCard
        status={status}
        onRefresh={vi.fn()}
        onOpenFiles={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('GameCard — Stop confirmation', () => {
  beforeEach(() => {
    apiMock.stop.mockResolvedValue(undefined);
    apiMock.start.mockResolvedValue(undefined);
    toastMock.mockClear();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('should show the confirmation dialog when Stop is clicked and the action is not suppressed', async () => {
    mockIsSuppressed.mockReturnValue(false);
    renderCard();

    await userEvent.click(screen.getByRole('button', { name: /stop/i }));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Stop minecraft?')).toBeInTheDocument();
  });

  it('should call api.stop directly without showing the dialog when the action is suppressed', async () => {
    mockIsSuppressed.mockReturnValue(true);
    renderCard();

    await userEvent.click(screen.getByRole('button', { name: /stop/i }));

    expect(apiMock.stop).toHaveBeenCalledWith('minecraft');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('should call api.stop after the user confirms the dialog', async () => {
    mockIsSuppressed.mockReturnValue(false);
    renderCard();

    await userEvent.click(screen.getByRole('button', { name: /stop/i }));
    await userEvent.click(screen.getByRole('button', { name: /stop server/i }));

    expect(apiMock.stop).toHaveBeenCalledWith('minecraft');
  });

  it('should not call api.stop when the user cancels the dialog', async () => {
    mockIsSuppressed.mockReturnValue(false);
    renderCard();

    await userEvent.click(screen.getByRole('button', { name: /stop/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(apiMock.stop).not.toHaveBeenCalled();
  });
});

describe('GameCard — Start/Stop toasts', () => {
  beforeEach(() => {
    apiMock.stop.mockResolvedValue(undefined);
    apiMock.start.mockResolvedValue(undefined);
    toastMock.mockClear();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('should show a success toast when Start succeeds', async () => {
    renderCard(stoppedStatus);

    await userEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(toastMock.success).toHaveBeenCalledWith('minecraft is starting');
  });

  it('should show an error toast with the error message when Start fails', async () => {
    apiMock.start.mockRejectedValueOnce(new Error('capacity exceeded'));
    renderCard(stoppedStatus);

    await userEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      'Failed to start minecraft',
      expect.objectContaining({ description: 'capacity exceeded' }),
    );
  });

  it('should show an error toast with the fallback description when Start fails with an unknown error', async () => {
    apiMock.start.mockRejectedValueOnce('not an Error');
    renderCard(stoppedStatus);

    await userEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      'Failed to start minecraft',
      expect.objectContaining({ description: 'An unknown error occurred' }),
    );
  });

  it('should show a stop toast with an Undo action when Stop succeeds', async () => {
    mockIsSuppressed.mockReturnValue(true);
    renderCard(runningStatus);

    await userEvent.click(screen.getByRole('button', { name: /stop/i }));

    expect(toastMock).toHaveBeenCalledWith(
      'minecraft stopped',
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Undo' }),
      }),
    );
  });

  it('should show an error toast with the error message when Stop fails', async () => {
    mockIsSuppressed.mockReturnValue(true);
    apiMock.stop.mockRejectedValueOnce(new Error('task not found'));
    renderCard(runningStatus);

    await userEvent.click(screen.getByRole('button', { name: /stop/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      'Failed to stop minecraft',
      expect.objectContaining({ description: 'task not found' }),
    );
  });
});
