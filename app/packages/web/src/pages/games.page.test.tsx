import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  costsEstimate: vi.fn(),
  games: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

import { GamesPage } from './games.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

/** A fully declared + deployed game — the "in sync" row. */
const declaredDeployed = {
  name: 'minecraft',
  declared: true,
  deployed: true,
  config: {
    name: 'minecraft',
    image: 'itzg/minecraft-server:latest',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [],
  },
};

/** Declared but not yet applied — the "pending deploy" row. */
const declaredOnly = {
  name: 'valheim',
  declared: true,
  deployed: false,
  config: {
    name: 'valheim',
    image: 'lloesche/valheim-server:latest',
    cpu: 4096,
    memory: 8192,
    ports: [{ container: 2456, protocol: 'udp' }],
    volumes: [],
  },
};

/** Deployed but no tfvars entry — the "ghost" / "undeclared" row (no `config`). */
const ghostRow = {
  name: 'terraria',
  declared: false,
  deployed: true,
};

describe('GamesPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    apiMock.games.mockResolvedValue({ games: [declaredDeployed, declaredOnly, ghostRow] });
  });

  it('should render the Games heading', () => {
    renderPage(<GamesPage />, { initialEntries: ['/games'] });
    expect(screen.getByRole('heading', { name: 'Games' })).toBeInTheDocument();
  });

  it('should render a row with the correct columns for a declared and deployed game', async () => {
    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    expect(await screen.findByText('minecraft')).toBeInTheDocument();
    expect(screen.getByText('In sync')).toBeInTheDocument();
    expect(screen.getByText('itzg/minecraft-server:latest')).toBeInTheDocument();
    expect(screen.getByText('25565/tcp')).toBeInTheDocument();
    expect(screen.getByText('1024')).toBeInTheDocument();
    expect(screen.getByText('2048')).toBeInTheDocument();
  });

  it('should render a "Pending deploy" chip for a declared-only game', async () => {
    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    expect(await screen.findByText('valheim')).toBeInTheDocument();
    expect(screen.getByText('Pending deploy')).toBeInTheDocument();
  });

  it('should render an "Undeclared" chip and em-dash columns for a ghost row', async () => {
    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    expect(await screen.findByText('terraria')).toBeInTheDocument();
    expect(screen.getByText('Undeclared')).toBeInTheDocument();

    const ghostCells = screen.getAllByText('—');
    // image, ports, cpu, memory columns all fall back to an em dash when
    // there's no declared `config` to read from.
    expect(ghostCells.length).toBeGreaterThanOrEqual(4);
  });

  it('should link each row to its /games/:name detail route', async () => {
    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    const link = await screen.findByRole('link', { name: 'minecraft' });
    expect(link).toHaveAttribute('href', '/games/minecraft');
  });

  it('should render an empty state when no games are declared or deployed', async () => {
    apiMock.games.mockResolvedValue({ games: [] });
    renderPage(<GamesPage />, { initialEntries: ['/games'] });

    expect(await screen.findByText('No games declared or deployed yet.')).toBeInTheDocument();
  });
});
