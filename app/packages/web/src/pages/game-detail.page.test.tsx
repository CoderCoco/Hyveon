import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  costsEstimate: vi.fn(),
  games: vi.fn(),
  updateGame: vi.fn(),
  deleteGame: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

/** Stub for `sonner`'s `toast`, pulled in transitively via `RemoveGameButton`. */
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

import { GameDetailPage } from './game-detail.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

const DECLARED_GAME = {
  name: 'minecraft',
  declared: true,
  deployed: true,
  config: {
    name: 'minecraft',
    image: 'itzg/minecraft-server:latest',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    environment: [{ name: 'EULA', value: 'TRUE' }],
    volumes: [{ name: 'minecraft-data', container_path: '/data' }],
    https: false,
    connect_message: 'Connect at minecraft.example.com',
    file_seeds: [{ path: '/data/server.properties', mode: '0644' }],
  },
};

const GHOST_GAME = {
  name: 'valheim',
  declared: false,
  deployed: true,
};

/** Renders the detail page at `/games/:name` for the given route param. */
function renderDetailPage(name: string) {
  return renderPage(
    <Routes>
      <Route path="/games/:name" element={<GameDetailPage />} />
    </Routes>,
    { initialEntries: [`/games/${name}`] },
  );
}

describe('GameDetailPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    apiMock.updateGame.mockReset();
    apiMock.deleteGame.mockReset();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  describe('a fully-declared game', () => {
    beforeEach(() => {
      apiMock.games.mockResolvedValue({ games: [DECLARED_GAME, GHOST_GAME] });
    });

    it('should render the game name and the "In sync" drift chip', async () => {
      renderDetailPage('minecraft');

      expect(await screen.findByText('In sync')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: 'minecraft' })).toBeInTheDocument();
    });

    it('should render the Container section with image, CPU, memory, and HTTPS fields', async () => {
      renderDetailPage('minecraft');

      expect(await screen.findByRole('heading', { name: 'Container' })).toBeInTheDocument();
      expect(screen.getByText('itzg/minecraft-server:latest')).toBeInTheDocument();
      expect(screen.getByText('1024')).toBeInTheDocument();
      expect(screen.getByText('2048')).toBeInTheDocument();
      expect(screen.getByText('Disabled')).toBeInTheDocument();
    });

    it('should render the Ports section with the container port and protocol', async () => {
      renderDetailPage('minecraft');

      expect(await screen.findByRole('heading', { name: 'Ports' })).toBeInTheDocument();
      expect(screen.getByText('25565')).toBeInTheDocument();
      expect(screen.getByText('tcp')).toBeInTheDocument();
    });

    it('should render the Volumes section with the volume name and container path', async () => {
      renderDetailPage('minecraft');

      expect(await screen.findByRole('heading', { name: 'Volumes' })).toBeInTheDocument();
      expect(screen.getByText('minecraft-data')).toBeInTheDocument();
      expect(screen.getByText('/data')).toBeInTheDocument();
    });

    it('should render the Environment variables section', async () => {
      renderDetailPage('minecraft');

      expect(await screen.findByRole('heading', { name: 'Environment variables' })).toBeInTheDocument();
      expect(screen.getByText('EULA')).toBeInTheDocument();
      expect(screen.getByText('TRUE')).toBeInTheDocument();
    });

    it('should render a collapsed File seeds section', async () => {
      renderDetailPage('minecraft');

      expect(await screen.findByRole('heading', { name: 'File seeds' })).toBeInTheDocument();
      expect(screen.getByText(/1 file seeded at task start/)).toBeInTheDocument();
      expect(screen.getByText(/server\.properties/)).toBeInTheDocument();
    });

    it('should render the Connect message section', async () => {
      renderDetailPage('minecraft');

      expect(await screen.findByRole('heading', { name: 'Connect message' })).toBeInTheDocument();
      expect(screen.getByText('Connect at minecraft.example.com')).toBeInTheDocument();
    });

    it('should toggle into the prefilled edit form when Edit is clicked', async () => {
      const user = userEvent.setup();
      renderDetailPage('minecraft');
      await screen.findByRole('heading', { name: 'Container' });

      await user.click(screen.getByRole('button', { name: 'Edit' }));

      expect(await screen.findByLabelText('Image')).toHaveValue('itzg/minecraft-server:latest');
      expect(screen.getByLabelText('Name')).toBeDisabled();
      expect(screen.getByLabelText('Name')).toHaveValue('minecraft');
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Container' })).toBeNull();
    });

    it('should reflect a saved change in the read-only view after onSaved', async () => {
      const user = userEvent.setup();
      const updatedGame = {
        ...DECLARED_GAME,
        config: { ...DECLARED_GAME.config, image: 'itzg/minecraft-server:2.0' },
      };
      apiMock.updateGame.mockResolvedValue({ ok: true, games: [updatedGame, GHOST_GAME] });
      renderDetailPage('minecraft');
      await screen.findByRole('heading', { name: 'Container' });

      await user.click(screen.getByRole('button', { name: 'Edit' }));
      const imageField = await screen.findByLabelText('Image');
      await user.clear(imageField);
      await user.type(imageField, 'itzg/minecraft-server:2.0');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(apiMock.updateGame).toHaveBeenCalled());
      expect(await screen.findByRole('heading', { name: 'Container' })).toBeInTheDocument();
      expect(screen.getByText('itzg/minecraft-server:2.0')).toBeInTheDocument();
      expect(screen.queryByLabelText('Image')).toBeNull();
    });

    it('should expose the Remove confirmation dialog', async () => {
      const user = userEvent.setup();
      renderDetailPage('minecraft');
      await screen.findByRole('heading', { name: 'Container' });

      await user.click(screen.getByRole('button', { name: 'Remove game' }));

      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).getByText('Remove minecraft?')).toBeInTheDocument();
    });
  });

  describe('a ghost game (deployed but not declared)', () => {
    beforeEach(() => {
      apiMock.games.mockResolvedValue({ games: [DECLARED_GAME, GHOST_GAME] });
    });

    it('should render the "Undeclared" drift chip', async () => {
      renderDetailPage('valheim');

      expect(await screen.findByText('Undeclared')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: 'valheim' })).toBeInTheDocument();
    });

    it('should show a message that there is no declared configuration', async () => {
      renderDetailPage('valheim');

      expect(await screen.findByText(/no declared configuration to show/i)).toBeInTheDocument();
    });

    it('should not render any of the config sections', async () => {
      renderDetailPage('valheim');

      await screen.findByText('Undeclared');
      expect(screen.queryByRole('heading', { name: 'Container' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Ports' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Volumes' })).toBeNull();
    });

    it('should hide the Edit and Remove controls', async () => {
      renderDetailPage('valheim');

      await screen.findByText('Undeclared');
      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Remove game' })).toBeNull();
    });
  });

  describe('an unknown :name param', () => {
    beforeEach(() => {
      apiMock.games.mockResolvedValue({ games: [DECLARED_GAME, GHOST_GAME] });
    });

    it('should show a "no game found" message', async () => {
      renderDetailPage('does-not-exist');

      expect(await screen.findByText(/no game named/i)).toBeInTheDocument();
      expect(screen.getByText(/"does-not-exist"/)).toBeInTheDocument();
    });

    it('should not render the drift chip or any config sections', async () => {
      renderDetailPage('does-not-exist');

      await screen.findByText(/no game named/i);
      expect(screen.queryByText('In sync')).toBeNull();
      expect(screen.queryByText('Undeclared')).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Container' })).toBeNull();
    });
  });
});
