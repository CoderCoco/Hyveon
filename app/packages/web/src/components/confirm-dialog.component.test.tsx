import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './confirm-dialog.component.js';
import { isSuppressed } from '../lib/confirm-skip.utils.js';

const mockStore = new Set<string>();

vi.mock('../lib/confirm-skip.utils.js', () => ({
  isSuppressed: (key: string) => mockStore.has(key),
  suppress: (key: string) => mockStore.add(key),
}));

function open(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Delete this?"
      description="This cannot be undone."
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { onConfirm, onOpenChange };
}

describe('ConfirmDialog', () => {
  beforeEach(() => {
    mockStore.clear();
  });

  it('should render the title and description', () => {
    open();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Delete this?')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
  });

  it('should call onConfirm when the confirm button is clicked', async () => {
    const { onConfirm } = open();
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('should not call onConfirm when cancel is clicked', async () => {
    const { onConfirm, onOpenChange } = open();
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('should disable Confirm until the typed value matches typeToConfirm', async () => {
    open({ typeToConfirm: 'abc123' });
    const confirmBtn = screen.getByRole('button', { name: /confirm/i });
    expect(confirmBtn).toBeDisabled();

    await userEvent.type(screen.getByRole('textbox'), 'abc123');
    expect(confirmBtn).not.toBeDisabled();
  });

  it('should suppress the key and call onConfirm when "don\'t ask again" is checked', async () => {
    const { onConfirm } = open({ confirmKey: 'test-key' });
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(isSuppressed('test-key')).toBe(true);
  });

  it('should not suppress the key when "don\'t ask again" is NOT checked', async () => {
    open({ confirmKey: 'other-key' });
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(isSuppressed('other-key')).toBe(false);
  });

  it('should use a custom confirmLabel when provided', () => {
    open({ confirmLabel: 'Yes, stop it' });
    expect(screen.getByRole('button', { name: 'Yes, stop it' })).toBeInTheDocument();
  });
});
