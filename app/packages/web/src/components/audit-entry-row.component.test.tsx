import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuditEntry } from '../api.service.js';
import { AuditEntryRow } from './audit-entry-row.component.js';

/** A minimal `edit` audit entry fixture with both `before` and `after` populated. */
const EDIT_ENTRY: AuditEntry = {
  sk: '2026-07-01T00:00:00.000Z#01J000',
  timestamp: '2026-07-01T00:00:00.000Z',
  actor: 'alice',
  action: 'edit',
  game: 'minecraft',
  before: { name: 'minecraft', image: 'itzg/minecraft-server:1', cpu: 1024, memory: 2048, ports: [], volumes: [] },
  after: { name: 'minecraft', image: 'itzg/minecraft-server:2', cpu: 1024, memory: 2048, ports: [], volumes: [] },
  versionId: 'v-123',
};

/** An `add` audit entry fixture — `before` is `null` and `versionId` is absent. */
const ADD_ENTRY: AuditEntry = {
  sk: '2026-07-02T00:00:00.000Z#01J001',
  timestamp: '2026-07-02T00:00:00.000Z',
  actor: 'bob',
  action: 'add',
  game: 'valheim',
  before: null,
  after: { name: 'valheim', image: 'lloesche/valheim-server', cpu: 512, memory: 1024, ports: [], volumes: [] },
};

/** Renders `AuditEntryRow` inside a minimal `<table>` shell, matching production usage. */
function renderRow(entry: AuditEntry) {
  return render(
    <table>
      <tbody>
        <AuditEntryRow entry={entry} />
      </tbody>
    </table>,
  );
}

describe('AuditEntryRow', () => {
  it('should render the timestamp, actor, action, game, and versionId summary columns', () => {
    renderRow(EDIT_ENTRY);

    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('edit')).toBeInTheDocument();
    expect(screen.getByText('minecraft')).toBeInTheDocument();
    expect(screen.getByText('v-123')).toBeInTheDocument();
  });

  it('should render an em dash for a missing versionId', () => {
    renderRow(ADD_ENTRY);

    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('should not render the before/after diff until expanded', () => {
    renderRow(EDIT_ENTRY);

    expect(screen.queryByText(/itzg\/minecraft-server:1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/itzg\/minecraft-server:2/)).not.toBeInTheDocument();
  });

  it('should expand to show the before/after JSON diff in two pre blocks when the row is clicked', async () => {
    renderRow(EDIT_ENTRY);

    await userEvent.click(screen.getByRole('button', { name: /expand diff/i }));

    const pres = screen.getAllByText(/itzg\/minecraft-server/, { selector: 'pre' });
    expect(pres).toHaveLength(2);
    expect(pres[0]).toHaveTextContent('itzg/minecraft-server:1');
    expect(pres[1]).toHaveTextContent('itzg/minecraft-server:2');
  });

  it('should render "null" for a before value that is null (e.g. an add entry)', async () => {
    renderRow(ADD_ENTRY);

    await userEvent.click(screen.getByRole('button', { name: /expand diff/i }));

    const pres = screen.getAllByRole('button', { name: /collapse diff/i });
    expect(pres).toHaveLength(1);
    expect(screen.getByText('null', { selector: 'pre' })).toBeInTheDocument();
  });

  it('should collapse the diff when the toggle is clicked again', async () => {
    renderRow(EDIT_ENTRY);

    const toggle = () => screen.getByRole('button', { name: /(expand|collapse) diff/i });
    await userEvent.click(toggle());
    expect(screen.getAllByText(/itzg\/minecraft-server/, { selector: 'pre' })).toHaveLength(2);

    await userEvent.click(toggle());
    expect(screen.queryByText(/itzg\/minecraft-server/, { selector: 'pre' })).not.toBeInTheDocument();
  });
});
