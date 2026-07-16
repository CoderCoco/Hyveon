import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getFargateMemoryOptions } from '@hyveon/shared/gameServerValidator';
import { ResourcesStep } from './resources-step.component.js';

/** Reads every non-placeholder `<option>` text from a select element, in DOM order. */
function optionValues(select: HTMLElement): string[] {
  return Array.from(select.querySelectorAll('option'))
    .map((option) => option.value)
    .filter((value) => value !== '');
}

describe('ResourcesStep', () => {
  it('should only offer Fargate-valid memory pairings for the selected cpu (256 -> 512/1024/2048)', () => {
    render(<ResourcesStep cpu={256} memory={null} onChange={() => undefined} issues={[]} />);

    const memorySelect = screen.getByLabelText('Memory (MiB)');
    expect(optionValues(memorySelect)).toEqual(['512', '1024', '2048']);
  });

  it('should only offer Fargate-valid memory pairings for the selected cpu (512 -> 1024/2048/3072/4096)', () => {
    render(<ResourcesStep cpu={512} memory={null} onChange={() => undefined} issues={[]} />);

    const memorySelect = screen.getByLabelText('Memory (MiB)');
    expect(optionValues(memorySelect)).toEqual(
      getFargateMemoryOptions(512).map((value) => String(value)),
    );
  });

  it('should offer no memory options and disable the memory select when no cpu is selected', () => {
    render(<ResourcesStep cpu={null} memory={null} onChange={() => undefined} issues={[]} />);

    const memorySelect = screen.getByLabelText('Memory (MiB)');
    expect(optionValues(memorySelect)).toEqual([]);
    expect(memorySelect).toBeDisabled();
  });

  it('should reset memory to unset when a cpu change makes the current memory value invalid', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    // cpu=256/memory=512 is a valid pairing; cpu=512 does not accept 512 MiB.
    render(<ResourcesStep cpu={256} memory={512} onChange={onChange} issues={[]} />);

    await user.selectOptions(screen.getByLabelText('CPU (vCPU units)'), '512');

    expect(onChange).toHaveBeenCalledWith({ cpu: 512, memory: null });
  });

  it('should keep the current memory value when a cpu change still supports it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    // cpu=512/memory=2048 is valid; cpu=1024 also accepts 2048.
    render(<ResourcesStep cpu={512} memory={2048} onChange={onChange} issues={[]} />);

    await user.selectOptions(screen.getByLabelText('CPU (vCPU units)'), '1024');

    expect(onChange).toHaveBeenCalledWith({ cpu: 1024, memory: 2048 });
  });

  it('should report a plain cpu change with the same memory when memory is unset', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ResourcesStep cpu={null} memory={null} onChange={onChange} issues={[]} />);

    await user.selectOptions(screen.getByLabelText('CPU (vCPU units)'), '256');

    expect(onChange).toHaveBeenCalledWith({ cpu: 256, memory: null });
  });

  it('should call onChange with the selected memory value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ResourcesStep cpu={256} memory={null} onChange={onChange} issues={[]} />);

    await user.selectOptions(screen.getByLabelText('Memory (MiB)'), '1024');

    expect(onChange).toHaveBeenCalledWith({ cpu: 256, memory: 1024 });
  });

  it('should surface a cpu validation issue beneath the cpu select', () => {
    render(
      <ResourcesStep
        cpu={100}
        memory={512}
        onChange={() => undefined}
        issues={[{ path: 'cpu', message: 'cpu must be one of the supported Fargate CPU units.' }]}
      />,
    );

    expect(screen.getByText('cpu must be one of the supported Fargate CPU units.')).toBeInTheDocument();
  });

  it('should surface a memory validation issue beneath the memory select', () => {
    render(
      <ResourcesStep
        cpu={256}
        memory={1536}
        onChange={() => undefined}
        issues={[{ path: 'memory', message: 'memory 1536 MiB is not a valid Fargate pairing for cpu=256.' }]}
      />,
    );

    expect(
      screen.getByText('memory 1536 MiB is not a valid Fargate pairing for cpu=256.'),
    ).toBeInTheDocument();
  });
});
