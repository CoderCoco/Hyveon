import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  costsEstimate: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

/** Stub for `window.gsd.terraform.runs.list` — the only channel this page invokes. */
const gsdMock = {
  terraform: {
    runs: {
      list: vi.fn(),
    },
  },
};
vi.stubGlobal('gsd', gsdMock);

import { TerraformHistoryPage } from './terraform-history.page.js';
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

describe('TerraformHistoryPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    gsdMock.terraform.runs.list.mockReset();
  });

  it('should render recent runs newest-first with kind, status, and timestamps', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({ records: [makeRecord()] });
    renderPage(<TerraformHistoryPage />);

    expect(await screen.findByText('apply')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Success')).toBeInTheDocument();
  });

  it('should show the empty state when no runs match the current filters', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({ records: [] });
    renderPage(<TerraformHistoryPage />);

    expect(await screen.findByText(/No runs match the current filters\./)).toBeInTheDocument();
  });

  it('should fetch the next, older page and append it when Load more is clicked', async () => {
    gsdMock.terraform.runs.list.mockResolvedValueOnce({
      records: [makeRecord({ runId: 'run-1', sk: 'sk-1' })],
      nextBefore: 'sk-1',
    });
    renderPage(<TerraformHistoryPage />);
    await screen.findByText('apply');

    gsdMock.terraform.runs.list.mockResolvedValueOnce({
      records: [makeRecord({ runId: 'run-2', sk: 'sk-2', kind: 'plan' })],
    });
    await userEvent.click(screen.getByRole('button', { name: /Load more/ }));

    expect(await screen.findByText('plan')).toBeInTheDocument();
    expect(gsdMock.terraform.runs.list).toHaveBeenLastCalledWith({ limit: 25, before: 'sk-1', status: undefined });
  });

  it('should re-fetch with the selected status filter', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({ records: [makeRecord({ status: 'failed' })] });
    renderPage(<TerraformHistoryPage />);
    await screen.findByText('apply');

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'failed');

    await waitFor(() =>
      expect(gsdMock.terraform.runs.list).toHaveBeenLastCalledWith({ limit: 25, status: 'failed' }),
    );
  });

  it('should apply the kind filter client-side without an extra fetch', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({
      records: [makeRecord({ runId: 'run-apply', kind: 'apply' }), makeRecord({ runId: 'run-plan', sk: 'sk-2', kind: 'plan' })],
    });
    renderPage(<TerraformHistoryPage />);
    await screen.findByText('apply');
    const callCountBefore = gsdMock.terraform.runs.list.mock.calls.length;

    await userEvent.selectOptions(screen.getByLabelText('Kind'), 'plan');

    expect(screen.queryByText('apply')).not.toBeInTheDocument();
    expect(screen.getByText('plan')).toBeInTheDocument();
    expect(gsdMock.terraform.runs.list.mock.calls.length).toBe(callCountBefore);
  });

  it('should link each row to its run-detail route', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({ records: [makeRecord({ runId: 'run-42' })] });
    renderPage(<TerraformHistoryPage />);

    const link = await screen.findByRole('link', { name: 'apply' });
    expect(link).toHaveAttribute('href', '/terraform/history/run-42');
  });

  it('should show approvedBy when present, else an em dash', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({
      records: [makeRecord({ runId: 'run-1', approvedBy: 'alice' }), makeRecord({ runId: 'run-2', sk: 'sk-2', kind: 'plan' })],
    });
    renderPage(<TerraformHistoryPage />);

    const rows = await screen.findAllByRole('row');
    const bodyRows = rows.slice(1);
    expect(within(bodyRows[0]!).getByText('alice')).toBeInTheDocument();
    expect(within(bodyRows[1]!).getByText('—')).toBeInTheDocument();
  });
});
