import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IdentityStep } from './identity-step.component.js';
import { createEmptyWizardDraft, type WizardDraft } from './wizard-form.utils.js';

/** Builds a blank draft with any fields overridden, so each test only specifies what it cares about. */
function makeDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return { ...createEmptyWizardDraft(), ...overrides };
}

describe('IdentityStep', () => {
  it('should render the draft name value', () => {
    render(<IdentityStep draft={makeDraft({ name: 'minecraft' })} issues={[]} onChange={vi.fn()} />);

    expect(screen.getByLabelText('Name')).toHaveValue('minecraft');
  });

  it('should render the draft image value', () => {
    render(<IdentityStep draft={makeDraft({ image: 'itzg/minecraft-server' })} issues={[]} onChange={vi.fn()} />);

    expect(screen.getByLabelText('Image')).toHaveValue('itzg/minecraft-server');
  });

  it('should render the draft connect_message value', () => {
    render(
      <IdentityStep draft={makeDraft({ connect_message: 'Connect at {ip}:25565' })} issues={[]} onChange={vi.fn()} />,
    );

    expect(screen.getByLabelText('Connect message')).toHaveValue('Connect at {ip}:25565');
  });

  it('should propagate a name edit via onChange', async () => {
    const onChange = vi.fn();
    render(<IdentityStep draft={makeDraft()} issues={[]} onChange={onChange} />);

    await userEvent.type(screen.getByLabelText('Name'), 'a');

    expect(onChange).toHaveBeenCalledWith({ name: 'a' });
  });

  it('should propagate an image edit via onChange', async () => {
    const onChange = vi.fn();
    render(<IdentityStep draft={makeDraft()} issues={[]} onChange={onChange} />);

    await userEvent.type(screen.getByLabelText('Image'), 'x');

    expect(onChange).toHaveBeenCalledWith({ image: 'x' });
  });

  it('should propagate a connect_message edit via onChange', async () => {
    const onChange = vi.fn();
    render(<IdentityStep draft={makeDraft()} issues={[]} onChange={onChange} />);

    await userEvent.type(screen.getByLabelText('Connect message'), 'c');

    expect(onChange).toHaveBeenCalledWith({ connect_message: 'c' });
  });

  it('should display the name error message when an issue path matches "name"', () => {
    render(
      <IdentityStep
        draft={makeDraft()}
        issues={[{ path: 'name', message: 'Name is required.' }]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Name is required.')).toBeInTheDocument();
  });

  it('should display the image error message when an issue path matches "image"', () => {
    render(
      <IdentityStep
        draft={makeDraft()}
        issues={[{ path: 'image', message: 'Image is required.' }]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Image is required.')).toBeInTheDocument();
  });

  it('should display the connect_message error message when an issue path matches "connect_message"', () => {
    render(
      <IdentityStep
        draft={makeDraft()}
        issues={[{ path: 'connect_message', message: 'Unknown placeholder in connect message.' }]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Unknown placeholder in connect message.')).toBeInTheDocument();
  });

  it('should not display an error for a field whose path has no matching issue', () => {
    render(
      <IdentityStep
        draft={makeDraft()}
        issues={[{ path: 'image', message: 'Image is required.' }]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByText('Name is required.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid', 'true');
  });
});
