import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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

/** A minimal running-server status fixture. */
const runningStatus = {
  game: 'minecraft',
  state: 'running' as const,
};

function renderCard() {
  return render(
    <MemoryRouter>
      <GameCard
        status={runningStatus}
        onRefresh={vi.fn()}
        onOpenFiles={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('GameCard — Stop confirmation', () => {
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
