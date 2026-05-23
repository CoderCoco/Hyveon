import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
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
    vi.clearAllTimers();
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
});
