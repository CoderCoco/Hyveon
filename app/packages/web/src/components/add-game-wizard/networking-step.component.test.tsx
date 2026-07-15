import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NetworkingStep } from './networking-step.component.js';
import type { WizardDraftPort } from './wizard-form.utils.js';

/** Two-row port fixture used across most cases below. */
function makePorts(): WizardDraftPort[] {
  return [
    { container: 25565, protocol: 'tcp' },
    { container: 25566, protocol: 'udp' },
  ];
}

describe('NetworkingStep', () => {
  it('should render "No ports configured yet" when the ports array is empty', () => {
    render(<NetworkingStep ports={[]} issues={[]} onChange={vi.fn()} />);

    expect(screen.getByText('No ports configured yet.')).toBeInTheDocument();
  });

  it('should append a blank row when "Add port" is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NetworkingStep ports={makePorts()} issues={[]} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Add port' }));

    expect(onChange).toHaveBeenCalledWith([
      { container: 25565, protocol: 'tcp' },
      { container: 25566, protocol: 'udp' },
      { container: null, protocol: 'tcp' },
    ]);
  });

  it('should remove the corresponding row when its "Remove" button is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NetworkingStep ports={makePorts()} issues={[]} onChange={onChange} />);

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    await user.click(removeButtons[0]);

    expect(onChange).toHaveBeenCalledWith([{ container: 25566, protocol: 'udp' }]);
  });

  it('should update the container port for the edited row when its number input changes', () => {
    const onChange = vi.fn();
    render(<NetworkingStep ports={makePorts()} issues={[]} onChange={onChange} />);

    const containerInput = screen.getByLabelText('Container port', {
      selector: '#port-container-1',
    });
    fireEvent.change(containerInput, { target: { value: '9000' } });

    expect(onChange).toHaveBeenCalledWith([
      { container: 25565, protocol: 'tcp' },
      { container: 9000, protocol: 'udp' },
    ]);
  });

  it('should update the protocol for the edited row when its select changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NetworkingStep ports={makePorts()} issues={[]} onChange={onChange} />);

    const protocolSelect = screen.getByLabelText('Protocol', { selector: '#port-protocol-0' });
    await user.selectOptions(protocolSelect, 'udp');

    expect(onChange).toHaveBeenCalledWith([
      { container: 25565, protocol: 'udp' },
      { container: 25566, protocol: 'udp' },
    ]);
  });

  it('should highlight only the second row when the error path is ports[1]', () => {
    render(
      <NetworkingStep
        ports={makePorts()}
        issues={[{ path: 'ports[1]', message: 'Port 25566/udp collides with ports[0].' }]}
        onChange={vi.fn()}
      />,
    );

    const firstRow = screen.getByTestId('port-row-0');
    const secondRow = screen.getByTestId('port-row-1');

    expect(firstRow.className).not.toContain('border-[var(--color-red)]');
    expect(secondRow.className).toContain('border-[var(--color-red)]');
    expect(screen.getByRole('alert')).toHaveTextContent('Port 25566/udp collides with ports[0].');
  });

  it('should highlight the row and surface the message when the error path is a field-level ports[N].field', () => {
    render(
      <NetworkingStep
        ports={makePorts()}
        issues={[{ path: 'ports[0].container', message: 'Expected number, received null' }]}
        onChange={vi.fn()}
      />,
    );

    const firstRow = screen.getByTestId('port-row-0');
    const secondRow = screen.getByTestId('port-row-1');

    expect(firstRow.className).toContain('border-[var(--color-red)]');
    expect(secondRow.className).not.toContain('border-[var(--color-red)]');
    expect(screen.getByRole('alert')).toHaveTextContent('Expected number, received null');
  });
});
