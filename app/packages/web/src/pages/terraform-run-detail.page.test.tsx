import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  costsEstimate: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

/** Stub for the `window.gsd.terraform.runs` channels this page invokes. */
const gsdMock = {
  terraform: {
    runs: {
      list: vi.fn(),
      streamLogs: vi.fn(),
      logUrl: vi.fn(),
    },
  },
};
vi.stubGlobal('gsd', gsdMock);

/**
 * Mock for the presigned-URL log fetch. Given its own `vi.fn()` (rather than
 * an inline `vi.stubGlobal('fetch', vi.fn(...))`) so `beforeEach` can fully
 * reset its implementation every test — a `mockResolvedValueOnce` queued
 * override is fragile here, since any stray extra invocation (e.g. a
 * duplicate effect run) silently falls through to whatever default was left
 * behind by a prior test instead of failing loudly.
 */
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

import { TerraformRunDetailPage } from './terraform-run-detail.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

/** Builds a sample `RunHistoryRecord`, overridable per-test. */
function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    sk: '2026-07-17T00:00:00.000Z#run-1',
    runId: 'run-1',
    kind: 'apply',
    status: 'success',
    startedAt: '2026-07-17T00:00:00.000Z',
    completedAt: '2026-07-17T00:05:00.000Z',
    exitCode: 0,
    ...overrides,
  };
}

/** Renders the detail page at `/terraform/history/:runId` for the given route param. */
function renderDetailPage(runId: string) {
  return renderPage(
    <Routes>
      <Route path="/terraform/history/:runId" element={<TerraformRunDetailPage />} />
    </Routes>,
    { initialEntries: [`/terraform/history/${runId}`] },
  );
}

describe('TerraformRunDetailPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    gsdMock.terraform.runs.list.mockReset();
    gsdMock.terraform.runs.streamLogs.mockReset();
    gsdMock.terraform.runs.logUrl.mockReset();
    gsdMock.terraform.runs.streamLogs.mockImplementation(async function* () {
      /* no local artifacts by default — subclasses override per test */
    });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'offloaded log text',
    } as Response);
  });

  it('should show a not-found message when no record matches the runId', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({ records: [] });
    renderDetailPage('run-missing');

    expect(await screen.findByText(/No run history record was found for "run-missing"\./)).toBeInTheDocument();
  });

  it('should render the record status, kind, and approver once resolved', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({
      records: [makeRecord({ approvedBy: 'alice', approvedAt: '2026-07-17T00:02:00.000Z' })],
    });
    renderDetailPage('run-1');

    expect(await screen.findByText('apply')).toBeInTheDocument();
    expect(screen.getByText('Success')).toBeInTheDocument();
    expect(screen.getByText(/Approved by/)).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('should replay the log via streamLogs when local run artifacts exist', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({ records: [makeRecord()] });
    gsdMock.terraform.runs.streamLogs.mockImplementation(async function* () {
      yield { stream: 'stdout', line: 'replayed line' };
    });
    renderDetailPage('run-1');

    expect(await screen.findByText('replayed line')).toBeInTheDocument();
    expect(gsdMock.terraform.runs.logUrl).not.toHaveBeenCalled();
  });

  it('should fall back to the inline log when streamLogs yields nothing', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({
      records: [makeRecord({ logInline: 'inline log text' })],
    });
    renderDetailPage('run-1');

    expect(await screen.findByText('inline log text')).toBeInTheDocument();
    expect(gsdMock.terraform.runs.logUrl).not.toHaveBeenCalled();
  });

  it('should fall back to streamLogs throwing, then a presigned URL fetch when logS3Key is set', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({
      records: [makeRecord({ logS3Key: 'runs/run-1.log' })],
    });
    // eslint-disable-next-line require-yield -- generator must throw before yielding to simulate missing local run artifacts
    gsdMock.terraform.runs.streamLogs.mockImplementation(async function* () {
      throw new Error('no run found for runId "run-1"');
    });
    gsdMock.terraform.runs.logUrl.mockResolvedValue('https://example.com/signed-log');
    renderDetailPage('run-1');

    expect(await screen.findByText('offloaded log text')).toBeInTheDocument();
    expect(gsdMock.terraform.runs.logUrl).toHaveBeenCalledWith('runs/run-1.log');
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/signed-log');
  });

  it('should treat a non-ok presigned URL fetch as no log available rather than rendering the error body', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({
      records: [makeRecord({ logS3Key: 'runs/run-1.log' })],
    });
    // eslint-disable-next-line require-yield -- generator must throw before yielding to simulate missing local run artifacts
    gsdMock.terraform.runs.streamLogs.mockImplementation(async function* () {
      throw new Error('no run found for runId "run-1"');
    });
    gsdMock.terraform.runs.logUrl.mockResolvedValue('https://example.com/expired-log');
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '<Error>AccessDenied</Error>',
    } as Response);
    renderDetailPage('run-1');

    expect(await screen.findByText('This run has no replayable, inline, or offloaded log.')).toBeInTheDocument();
    expect(gsdMock.terraform.runs.logUrl).toHaveBeenCalledWith('runs/run-1.log');
    expect(screen.queryByText('<Error>AccessDenied</Error>')).not.toBeInTheDocument();
  });

  it('should not render any approve/apply controls for a terminal run', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({ records: [makeRecord({ logInline: 'log' })] });
    renderDetailPage('run-1');

    await screen.findByText('log');
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument();
  });
});
