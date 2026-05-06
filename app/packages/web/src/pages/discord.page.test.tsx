import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  costsEstimate: vi.fn(),
  games: vi.fn(),
  discordConfig: vi.fn(),
  discordRemoveGuild: vi.fn().mockResolvedValue(undefined),
  discordDeletePermission: vi.fn().mockResolvedValue(undefined),
  discordSaveAdmins: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

import { DiscordPage } from './discord.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

const REDACTED_CONFIG = {
  clientId: '123456789012345678',
  allowedGuilds: ['111111111111111111'],
  admins: { userIds: [], roleIds: [] },
  gamePermissions: {},
  baseAllowedGuilds: [],
  baseAdmins: { userIds: [], roleIds: [] },
  botTokenSet: true,
  publicKeySet: true,
  interactionsEndpointUrl: 'https://example.amazonaws.com/discord',
};

describe('DiscordPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    apiMock.games.mockResolvedValue({ games: ['minecraft'] });
    apiMock.discordConfig.mockResolvedValue(REDACTED_CONFIG);
  });

  it('should render the Discord heading and the polling indicator wired to the status poll', async () => {
    renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

    // Wait for the configured-state header to render — the early-load path
    // also has an h2 with the same text, so anchor on the description copy
    // that only appears once the redacted config has resolved.
    expect(await screen.findByText(/Slash-command bot configuration/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Discord' })).toBeInTheDocument();
    expect(await screen.findByText(/^Updated\b/)).toBeInTheDocument();
  });

  it('should render the configuration tabs once the redacted config resolves', async () => {
    renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

    expect(await screen.findByRole('tab', { name: 'Credentials' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Guilds' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Admins' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Per-Game Permissions' })).toBeInTheDocument();
  });

  it('should show the unavailable-state copy when /api/discord/config rejects', async () => {
    apiMock.discordConfig.mockRejectedValue(new Error('boom'));
    renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

    expect(await screen.findByText(/Discord config unavailable/i)).toBeInTheDocument();
  });

  it('should keep the polling indicator visible while /api/discord/config is loading', async () => {
    // Hold the discord-config response open so the page stays in its
    // loading state for the duration of the assertions.
    apiMock.discordConfig.mockReturnValue(new Promise(() => undefined));
    renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

    // Loading copy is rendered, AND the indicator is wired to the (mocked)
    // status poll above so the operator can still see "Updated …".
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByText(/^Updated\b/)).toBeInTheDocument();
  });

  describe('Per-Game Permissions tab — Clear', () => {
    it('should open a confirmation dialog when Clear is clicked', async () => {
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      // Navigate to the Per-Game Permissions tab
      await userEvent.click(await screen.findByRole('tab', { name: 'Per-Game Permissions' }));

      // Click the Clear button for the minecraft row
      await userEvent.click(screen.getByRole('button', { name: /clear/i }));

      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(screen.getByText('Clear permissions for minecraft?')).toBeInTheDocument();
    });

    it('should call the delete API after the user confirms', async () => {
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await userEvent.click(await screen.findByRole('tab', { name: 'Per-Game Permissions' }));
      await userEvent.click(screen.getByRole('button', { name: /clear/i }));
      await userEvent.click(screen.getByRole('button', { name: /^clear$/i }));

      expect(apiMock.discordDeletePermission).toHaveBeenCalledWith('minecraft');
    });
  });

  describe('Guilds tab — Remove guild', () => {
    it('should open a confirmation dialog when Remove is clicked', async () => {
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      // Navigate to the Guilds tab
      await userEvent.click(await screen.findByRole('tab', { name: 'Guilds' }));

      // Click the Remove button for the guild
      await userEvent.click(screen.getByRole('button', { name: /remove/i }));

      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(screen.getByText('Remove guild?')).toBeInTheDocument();
    });

    it('should enable Confirm only after the guild ID is typed', async () => {
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await userEvent.click(await screen.findByRole('tab', { name: 'Guilds' }));
      await userEvent.click(screen.getByRole('button', { name: /remove/i }));

      const confirmBtn = screen.getByRole('button', { name: /remove guild/i });
      expect(confirmBtn).toBeDisabled();

      await userEvent.type(screen.getByRole('textbox'), '111111111111111111');
      expect(confirmBtn).not.toBeDisabled();
    });

    it('should call the remove API after the user types the guild ID and confirms', async () => {
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await userEvent.click(await screen.findByRole('tab', { name: 'Guilds' }));
      await userEvent.click(screen.getByRole('button', { name: /remove/i }));

      await userEvent.type(screen.getByRole('textbox'), '111111111111111111');
      await userEvent.click(screen.getByRole('button', { name: /remove guild/i }));

      expect(apiMock.discordRemoveGuild).toHaveBeenCalledWith('111111111111111111');
    });
  });

  describe('Admins tab — Remove admin', () => {
    const CONFIG_WITH_ADMINS = {
      ...REDACTED_CONFIG,
      admins: {
        userIds: ['111222333444555666'],
        roleIds: ['999888777666555444'],
      },
    };

    it('should open a confirmation dialog when the X button is clicked on an admin user ID chip', async () => {
      apiMock.discordConfig.mockResolvedValue(CONFIG_WITH_ADMINS);
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await userEvent.click(await screen.findByRole('tab', { name: 'Admins' }));

      await userEvent.click(screen.getByRole('button', { name: /remove 111222333444555666/i }));

      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(screen.getByText('Remove admin?')).toBeInTheDocument();
    });

    it('should open a confirmation dialog when the X button is clicked on an admin role ID chip', async () => {
      apiMock.discordConfig.mockResolvedValue(CONFIG_WITH_ADMINS);
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await userEvent.click(await screen.findByRole('tab', { name: 'Admins' }));

      await userEvent.click(screen.getByRole('button', { name: /remove 999888777666555444/i }));

      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });

    it('should remove the user ID from the chip list after the user confirms', async () => {
      apiMock.discordConfig.mockResolvedValue(CONFIG_WITH_ADMINS);
      renderPage(<DiscordPage />, { initialEntries: ['/discord'] });

      await userEvent.click(await screen.findByRole('tab', { name: 'Admins' }));
      await userEvent.click(screen.getByRole('button', { name: /remove 111222333444555666/i }));
      await userEvent.click(screen.getByRole('button', { name: /^remove$/i }));

      expect(screen.queryByText('111222333444555666')).not.toBeInTheDocument();
    });
  });
});
