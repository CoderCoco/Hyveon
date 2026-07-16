import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StorageStep } from './storage-step.component.js';
import type { WizardDraft } from './wizard-form.utils.js';

/** Builds a minimal draft for the Storage step; only `volumes`/`file_seeds` matter here. */
function makeDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return {
    name: 'minecraft',
    image: 'itzg/minecraft-server',
    connect_message: '',
    cpu: 1024,
    memory: 2048,
    ports: [],
    volumes: [{ name: 'data', container_path: '/data' }],
    file_seeds: [],
    ...overrides,
  };
}

describe('StorageStep', () => {
  describe('volumes', () => {
    it('should disable the remove button on the only volume row', () => {
      render(<StorageStep draft={makeDraft()} issues={[]} onChange={vi.fn()} />);

      expect(screen.getByRole('button', { name: /Remove volume 1/ })).toBeDisabled();
    });

    it('should enable remove buttons when there are multiple volume rows', () => {
      render(
        <StorageStep
          draft={makeDraft({
            volumes: [
              { name: 'data', container_path: '/data' },
              { name: 'saves', container_path: '/saves' },
            ],
          })}
          issues={[]}
          onChange={vi.fn()}
        />,
      );

      const removeButtons = screen.getAllByRole('button', { name: /Remove volume/ });
      expect(removeButtons).toHaveLength(2);
      expect(removeButtons[0]).not.toBeDisabled();
      expect(removeButtons[1]).not.toBeDisabled();
    });

    it('should call onChange with the row removed when a non-last volume row is removed', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <StorageStep
          draft={makeDraft({
            volumes: [
              { name: 'data', container_path: '/data' },
              { name: 'saves', container_path: '/saves' },
            ],
          })}
          issues={[]}
          onChange={onChange}
        />,
      );

      const removeButtons = screen.getAllByRole('button', { name: /Remove volume/ });
      await user.click(removeButtons[1]);

      expect(onChange).toHaveBeenCalledWith({ volumes: [{ name: 'data', container_path: '/data' }] });
    });

    it('should not remove the last volume row even if its disabled remove button is clicked', () => {
      const onChange = vi.fn();
      render(<StorageStep draft={makeDraft()} issues={[]} onChange={onChange} />);

      fireEvent.click(screen.getByRole('button', { name: /Remove volume 1/ }));

      expect(onChange).not.toHaveBeenCalled();
    });

    it('should append a blank volume row when "Add volume" is clicked', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<StorageStep draft={makeDraft()} issues={[]} onChange={onChange} />);

      await user.click(screen.getByRole('button', { name: 'Add volume' }));

      expect(onChange).toHaveBeenCalledWith({
        volumes: [
          { name: 'data', container_path: '/data' },
          { name: '', container_path: '' },
        ],
      });
    });

    it('should update the name field for the edited volume row', () => {
      const onChange = vi.fn();
      render(<StorageStep draft={makeDraft()} issues={[]} onChange={onChange} />);

      fireEvent.change(screen.getByLabelText('Volume name'), { target: { value: 'world' } });

      expect(onChange).toHaveBeenCalledWith({ volumes: [{ name: 'world', container_path: '/data' }] });
    });

    it('should update the container_path field for the edited volume row', () => {
      const onChange = vi.fn();
      render(<StorageStep draft={makeDraft()} issues={[]} onChange={onChange} />);

      fireEvent.change(screen.getByLabelText('Container path'), { target: { value: '/world' } });

      expect(onChange).toHaveBeenCalledWith({ volumes: [{ name: 'data', container_path: '/world' }] });
    });

    it('should render a general error banner when the issue path is exactly "volumes"', () => {
      render(
        <StorageStep
          draft={makeDraft({ volumes: [] })}
          issues={[
            {
              path: 'volumes',
              message: 'Each game server must have at least one volume entry with non-empty name and container_path.',
            },
          ]}
          onChange={vi.fn()}
        />,
      );

      expect(screen.getByRole('alert')).toHaveTextContent(
        'Each game server must have at least one volume entry with non-empty name and container_path.',
      );
    });

    it('should attach an indexed volumes[1].container_path error to only the second row', () => {
      render(
        <StorageStep
          draft={makeDraft({
            volumes: [
              { name: 'data', container_path: '/data' },
              { name: 'saves', container_path: 'saves' },
            ],
          })}
          issues={[{ path: 'volumes[1].container_path', message: 'volumes[1].container_path must be an absolute path.' }]}
          onChange={vi.fn()}
        />,
      );

      const firstRow = screen.getByTestId('volume-row-0');
      const secondRow = screen.getByTestId('volume-row-1');

      expect(within(firstRow).queryByText('volumes[1].container_path must be an absolute path.')).toBeNull();
      expect(within(secondRow).getByText('volumes[1].container_path must be an absolute path.')).toBeInTheDocument();
    });

    it('should attach an indexed volumes[0].name error to only the first row', () => {
      render(
        <StorageStep
          draft={makeDraft({
            volumes: [
              { name: '', container_path: '/data' },
              { name: 'saves', container_path: '/saves' },
            ],
          })}
          issues={[{ path: 'volumes[0].name', message: 'volumes[].name must not be empty.' }]}
          onChange={vi.fn()}
        />,
      );

      const firstRow = screen.getByTestId('volume-row-0');
      const secondRow = screen.getByTestId('volume-row-1');

      expect(within(firstRow).getByText('volumes[].name must not be empty.')).toBeInTheDocument();
      expect(within(secondRow).queryByText('volumes[].name must not be empty.')).toBeNull();
    });
  });

  describe('file_seeds', () => {
    it('should render "No file seeds configured." when file_seeds is empty', () => {
      render(<StorageStep draft={makeDraft()} issues={[]} onChange={vi.fn()} />);

      expect(screen.getByText('No file seeds configured.')).toBeInTheDocument();
    });

    it('should append a blank file seed row when "Add file seed" is clicked', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<StorageStep draft={makeDraft()} issues={[]} onChange={onChange} />);

      await user.click(screen.getByRole('button', { name: 'Add file seed' }));

      expect(onChange).toHaveBeenCalledWith({
        file_seeds: [{ path: '', content: '', content_base64: '', mode: '' }],
      });
    });

    it('should never disable a file seed row\'s remove button, even when it is the only row', () => {
      render(
        <StorageStep
          draft={makeDraft({ file_seeds: [{ path: '/data/config.yml', content: '', content_base64: '', mode: '' }] })}
          issues={[]}
          onChange={vi.fn()}
        />,
      );

      expect(screen.getByRole('button', { name: /Remove file seed 1/ })).not.toBeDisabled();
    });

    it('should call onChange with an empty file_seeds array when the only row is removed', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <StorageStep
          draft={makeDraft({ file_seeds: [{ path: '/data/config.yml', content: '', content_base64: '', mode: '' }] })}
          issues={[]}
          onChange={onChange}
        />,
      );

      await user.click(screen.getByRole('button', { name: /Remove file seed 1/ }));

      expect(onChange).toHaveBeenCalledWith({ file_seeds: [] });
    });

    it('should update every field of a file seed row via onChange', () => {
      const onChange = vi.fn();
      const seed = { path: '/data/config.yml', content: 'foo: bar', content_base64: '', mode: '' };
      render(<StorageStep draft={makeDraft({ file_seeds: [seed] })} issues={[]} onChange={onChange} />);

      fireEvent.change(screen.getByLabelText('Path'), { target: { value: '/data/other.yml' } });
      expect(onChange).toHaveBeenLastCalledWith({ file_seeds: [{ ...seed, path: '/data/other.yml' }] });

      fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'baz: qux' } });
      expect(onChange).toHaveBeenLastCalledWith({ file_seeds: [{ ...seed, content: 'baz: qux' }] });

      fireEvent.change(screen.getByLabelText('Content (base64)'), { target: { value: 'YmF6' } });
      expect(onChange).toHaveBeenLastCalledWith({ file_seeds: [{ ...seed, content_base64: 'YmF6' }] });

      fireEvent.change(screen.getByLabelText('Mode'), { target: { value: '0644' } });
      expect(onChange).toHaveBeenLastCalledWith({ file_seeds: [{ ...seed, mode: '0644' }] });
    });

    it('should attach an indexed file_seeds[0].path error to only the first file seed row', () => {
      render(
        <StorageStep
          draft={makeDraft({
            file_seeds: [
              { path: 'config.yml', content: '', content_base64: '', mode: '' },
              { path: '/data/other.yml', content: '', content_base64: '', mode: '' },
            ],
          })}
          issues={[{ path: 'file_seeds[0].path', message: 'file_seeds[0].path must be an absolute path.' }]}
          onChange={vi.fn()}
        />,
      );

      const firstRow = screen.getByTestId('file-seed-row-0');
      const secondRow = screen.getByTestId('file-seed-row-1');

      expect(within(firstRow).getByText('file_seeds[0].path must be an absolute path.')).toBeInTheDocument();
      expect(within(secondRow).queryByText('file_seeds[0].path must be an absolute path.')).toBeNull();
      expect(firstRow.className).toContain('border-[var(--color-red)]');
      expect(secondRow.className).not.toContain('border-[var(--color-red)]');
    });
  });
});
