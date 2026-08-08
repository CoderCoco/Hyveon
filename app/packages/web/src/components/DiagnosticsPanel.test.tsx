import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiagnosticsPanel } from './DiagnosticsPanel.js';

// Mock the API client. `vi.mock` is hoisted so the import of DiagnosticsPanel
// above picks up the stub automatically.
const apiMock = vi.hoisted(() => ({
  diagnosticsTail: vi.fn(),
  diagnosticsLogPath: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

/** Sample log lines returned by the mocked API. */
const SAMPLE_LINES = [
  '2026-05-23T10:00:00Z INFO Server started',
  '2026-05-23T10:00:01Z DEBUG Loaded config',
  '2026-05-23T10:00:02Z WARN Memory usage high',
];

const SAMPLE_PATH = '/var/log/hyveon/diagnostics.log';

describe('DiagnosticsPanel', () => {
  beforeEach(() => {
    // Default: both API calls resolve successfully.
    apiMock.diagnosticsTail.mockResolvedValue({ lines: SAMPLE_LINES });
    apiMock.diagnosticsLogPath.mockResolvedValue({ path: SAMPLE_PATH });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should render loading state before data arrives', () => {
    // Keep the promise pending so loading remains true during the assertion.
    apiMock.diagnosticsTail.mockReturnValue(new Promise(() => {}));
    apiMock.diagnosticsLogPath.mockReturnValue(new Promise(() => {}));

    render(<DiagnosticsPanel />);

    expect(screen.getByText('Loading diagnostics…')).toBeInTheDocument();
  });

  it('should render log lines returned by api.diagnosticsTail', async () => {
    render(<DiagnosticsPanel />);

    await waitFor(() => {
      expect(screen.getByText('2026-05-23T10:00:00Z INFO Server started')).toBeInTheDocument();
    });

    expect(screen.getByText('2026-05-23T10:00:01Z DEBUG Loaded config')).toBeInTheDocument();
    expect(screen.getByText('2026-05-23T10:00:02Z WARN Memory usage high')).toBeInTheDocument();
  });

  it('should display the log file path', async () => {
    render(<DiagnosticsPanel />);

    await waitFor(() => {
      expect(screen.getByText(SAMPLE_PATH)).toBeInTheDocument();
    });

    expect(screen.getByText(/Log file:/)).toBeInTheDocument();
  });

  it('should show an error message when api.diagnosticsTail rejects', async () => {
    apiMock.diagnosticsTail.mockRejectedValue(new Error('Network error'));

    render(<DiagnosticsPanel />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Network error');
  });

  it('should poll for new lines every 5 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(<DiagnosticsPanel />);

    // Wait for the initial fetch to complete (real microtask queue flushes even
    // under fake timers when shouldAdvanceTime is true).
    await waitFor(() => {
      expect(apiMock.diagnosticsTail).toHaveBeenCalledTimes(1);
    });

    // Advance by one poll interval and let the queued microtasks settle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(apiMock.diagnosticsTail).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('should toggle the Pause / Resume button label', async () => {
    const user = userEvent.setup();
    render(<DiagnosticsPanel />);
    await screen.findByText(/Server started/);

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('should color-code lines containing INFO/WARN/ERROR/DEBUG with badges', async () => {
    render(<DiagnosticsPanel />);
    await screen.findByText(/Server started/);

    for (const lvl of ['INFO', 'DEBUG', 'WARN']) {
      expect(screen.getAllByText(lvl, { exact: true }).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('should highlight matches inside <mark> when typing in the search input, without filtering non-matching lines', async () => {
    const user = userEvent.setup();
    const { container } = render(<DiagnosticsPanel />);
    await screen.findByText(/Server started/);

    expect(container.querySelectorAll('mark')).toHaveLength(0);

    await user.type(screen.getByPlaceholderText('Search visible lines…'), 'Memory');

    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(Array.from(marks).some((m) => m.textContent === 'Memory')).toBe(true);
    expect(screen.getByText(/Server started/)).toBeInTheDocument();
  });

  it('should hide WARN-level lines after unchecking WARN in the Levels filter', async () => {
    const user = userEvent.setup();
    render(<DiagnosticsPanel />);
    await screen.findByText(/Server started/);
    expect(screen.getByText(/Memory usage high/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Levels/ }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'WARN' }));

    await waitFor(() => {
      expect(screen.queryByText(/Memory usage high/)).toBeNull();
    });
  });

  it('should freeze the displayed lines while paused even as polling continues', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DiagnosticsPanel />);
    await waitFor(() => expect(apiMock.diagnosticsTail).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Pause' }));

    const nextLines = [...SAMPLE_LINES, '2026-05-23T10:00:03Z INFO New line while paused'];
    apiMock.diagnosticsTail.mockResolvedValue({ lines: nextLines });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    // Polling happened...
    expect(apiMock.diagnosticsTail).toHaveBeenCalledTimes(2);
    // ...but the paused view still shows only the original snapshot.
    expect(screen.queryByText(/New line while paused/)).toBeNull();
    expect(screen.getByText('2026-05-23T10:00:00Z INFO Server started')).toBeInTheDocument();

    vi.useRealTimers();
  });

  it('should swap to the latest fetched snapshot in one step on resume, with no duplicated lines', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DiagnosticsPanel />);
    await waitFor(() => expect(apiMock.diagnosticsTail).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Pause' }));

    const secondSnapshot = [...SAMPLE_LINES, '2026-05-23T10:00:03Z INFO Second poll while paused'];
    const thirdSnapshot = [...SAMPLE_LINES, '2026-05-23T10:00:04Z INFO Third poll while paused'];
    apiMock.diagnosticsTail.mockResolvedValueOnce({ lines: secondSnapshot }).mockResolvedValue({ lines: thirdSnapshot });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(apiMock.diagnosticsTail).toHaveBeenCalledTimes(3);

    await user.click(screen.getByRole('button', { name: 'Resume' }));

    // Only the latest (third) snapshot is shown — the second poll's line never renders at all.
    expect(screen.getByText(/Third poll while paused/)).toBeInTheDocument();
    expect(screen.queryByText(/Second poll while paused/)).toBeNull();
    // No duplication of lines carried over from the original snapshot.
    expect(screen.getAllByText('2026-05-23T10:00:00Z INFO Server started')).toHaveLength(1);

    vi.useRealTimers();
  });

  it('should autoscroll to the bottom on update while not paused', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<DiagnosticsPanel />);
    await waitFor(() => expect(apiMock.diagnosticsTail).toHaveBeenCalledTimes(1));

    const box = screen.getByTestId('diagnostics-log-box');
    Object.defineProperty(box, 'scrollHeight', { value: 999, configurable: true });
    box.scrollTop = 0;

    apiMock.diagnosticsTail.mockResolvedValue({ lines: [...SAMPLE_LINES, '2026-05-23T10:00:03Z INFO One more line'] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(box.scrollTop).toBe(999);

    vi.useRealTimers();
  });

  it('should not autoscroll while paused', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DiagnosticsPanel />);
    await waitFor(() => expect(apiMock.diagnosticsTail).toHaveBeenCalledTimes(1));

    const box = screen.getByTestId('diagnostics-log-box');
    Object.defineProperty(box, 'scrollHeight', { value: 999, configurable: true });
    box.scrollTop = 0;

    await user.click(screen.getByRole('button', { name: 'Pause' }));

    apiMock.diagnosticsTail.mockResolvedValue({ lines: [...SAMPLE_LINES, '2026-05-23T10:00:03Z INFO Ignored while paused'] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(box.scrollTop).toBe(0);

    vi.useRealTimers();
  });
});
