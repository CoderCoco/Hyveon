import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RemoveGameButton } from './remove-game-button.component.js';

/** Stub for `@/api.service.js` — only `deleteGame` is called by this component. */
const apiMock = vi.hoisted(() => ({ deleteGame: vi.fn() }));
vi.mock('../api.service.js', () => ({ api: apiMock }));

/** Stub for `sonner`'s `toast`, so success/failure toasts can be asserted without a real toaster mounted. */
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

/**
 * Stub for `react-router-dom`'s `useNavigate` and `Link` — the component
 * only ever uses these two exports, so a full mock (no real `MemoryRouter`
 * needed) keeps the test setup minimal. `Link` renders a plain anchor so the
 * dialog's "apply the change" hint can be asserted on without routing.
 */
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

/** Opens the remove-game dialog via its trigger button and waits for it to render. */
async function openDialog(game = 'minecraft') {
  render(<RemoveGameButton game={game} />);
  await userEvent.click(screen.getByRole('button', { name: 'Remove game' }));
  await screen.findByRole('alertdialog');
}

describe('RemoveGameButton', () => {
  beforeEach(() => {
    apiMock.deleteGame.mockReset();
    navigateMock.mockClear();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('should disable the confirm button until the exact game name is typed', async () => {
    await openDialog('minecraft');
    // There are two "Remove game" buttons once the dialog is open: the
    // trigger (now behind the dialog) and the AlertDialogAction. Scope to
    // the dialog to get the confirm button specifically.
    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = within(dialog).getByRole('button', { name: 'Remove game' });
    const input = within(dialog).getByRole('textbox', { name: /type the game name/i });

    expect(confirmBtn).toBeDisabled();

    await userEvent.type(input, 'minec');
    expect(confirmBtn).toBeDisabled();

    await userEvent.type(input, 'raft');
    expect(confirmBtn).not.toBeDisabled();
  });

  it('should not call api.deleteGame when cancel is clicked', async () => {
    await openDialog('minecraft');
    const dialog = screen.getByRole('alertdialog');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(apiMock.deleteGame).not.toHaveBeenCalled();
  });

  it('should call api.deleteGame with the game name and navigate to /games on success', async () => {
    apiMock.deleteGame.mockResolvedValue({ ok: true, games: [] });
    await openDialog('minecraft');
    const dialog = screen.getByRole('alertdialog');

    await userEvent.type(within(dialog).getByRole('textbox', { name: /type the game name/i }), 'minecraft');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove game' }));

    expect(apiMock.deleteGame).toHaveBeenCalledWith({ name: 'minecraft' });
    expect(navigateMock).toHaveBeenCalledWith('/games');
    expect(toastMock.success).toHaveBeenCalledOnce();
  });

  it('should show an error toast and not navigate when the server rejects the delete', async () => {
    apiMock.deleteGame.mockResolvedValue({ ok: false, code: 'not_found', message: 'No such game.' });
    await openDialog('minecraft');
    const dialog = screen.getByRole('alertdialog');

    await userEvent.type(within(dialog).getByRole('textbox', { name: /type the game name/i }), 'minecraft');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove game' }));

    expect(apiMock.deleteGame).toHaveBeenCalledWith({ name: 'minecraft' });
    expect(navigateMock).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledOnce();
  });

  it('should show the terraform.tfvars hint and a link to the Terraform page in the dialog', async () => {
    await openDialog('minecraft');
    const dialog = screen.getByRole('alertdialog');

    expect(within(dialog).getByText('terraform.tfvars')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Terraform' })).toHaveAttribute('href', '/terraform');
  });
});
