import type { ElectronApplication, Page } from '../fixtures/index.js';
import {
  test,
  expect,
  _electron,
  CONFIGURED_DISCORD_CONFIG,
  FIRST_RUN_DISCORD_CONFIG,
  MULTI_GAME_STATUSES,
  STOPPED_GAME,
  VALID_GUILD_ID,
  VALID_GUILD_ID_2,
  VALID_USER_ID,
  AppLayout,
  DiscordPage,
  seedDiscordMocks,
  clearElectronMocks,
  type DiscordConfigRedacted,
} from '../fixtures/index.js';
import { electronMain, electronEnv } from '../../playwright.config.js';

// ── Shared Electron application ──────────────────────────────────────────────
//
// A single ElectronApplication is launched once for the whole describe block.
// Each test seeds its own IPC mocks via `window.gsd.__test.mock()`, navigates
// to `/discord`, drives the UI, then `clearElectronMocks()` in afterEach resets
// the registry so stale handlers never bleed into the next test.

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  app = await _electron.launch({ args: [electronMain], env: electronEnv });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await app.close();
});

test.afterEach(async () => {
  await clearElectronMocks(win);
});

// ── Navigation helper ─────────────────────────────────────────────────────────
//
// `page.goto('/discord')` resolves against the `file://` base URL used by
// `loadFile()`, producing `file:///discord` which won't match any route.
// Instead, we use `history.pushState` so React Router re-renders at `/discord`
// without a full page reload.
//
// We first push to `/` to unmount the Discord component (in case a prior test
// left the window at `/discord`), then push to `/discord` to remount it fresh.
// Both steps must happen after mocks are seeded, so the global polling providers
// and the Discord page's own `useEffect` each see a response for every channel.

async function gotoDiscord(page: Page): Promise<void> {
  // Step 1 — unmount any previously mounted Discord page.
  await page.evaluate(() => {
    window.history.pushState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  // Step 2 — navigate to /discord so the component mounts with mocks in place.
  await page.evaluate(() => {
    window.history.pushState({}, '', '/discord');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

// ── Base mock seeder ──────────────────────────────────────────────────────────
//
// Seeds every non-Discord IPC channel consumed by the global providers
// (PollingProvider, GameStatusProvider) so they don't reach the real Nest
// microservice while a test is running.

async function seedBaseMocks(
  page: Page,
  statuses: Array<{ game: string; state: string; publicIp?: string }> = [STOPPED_GAME],
): Promise<void> {
  await page.evaluate((s) => {
    const gsd = (window as Record<string, unknown>)['gsd'] as {
      __test: { mock: (channel: string, handler: unknown) => void };
    };
    gsd.__test.mock('env.get', () =>
      Promise.resolve({ region: 'us-east-1', domain: 'example.com', environment: 'dev' }),
    );
    gsd.__test.mock('games.status', () => Promise.resolve(s));
    gsd.__test.mock('games.list', () =>
      Promise.resolve({ games: (s as Array<{ game: string }>).map((x) => x.game) }),
    );
    gsd.__test.mock('config.get', () =>
      Promise.resolve({
        watchdog_interval_minutes: 15,
        watchdog_idle_checks: 4,
        watchdog_min_packets: 100,
      }),
    );
    gsd.__test.mock('costs.estimate', () =>
      Promise.resolve({ games: {}, totalPerHourIfAllOn: 0 }),
    );
    gsd.__test.mock('costs.actual', () =>
      Promise.resolve({ daily: [], total: 0, currency: 'USD', days: 7 }),
    );
  }, statuses);
}

// ── Specs ──────────────────────────────────────────────────────────────────────

test.describe('discord settings', () => {
  test('should show the setup wizard when no guilds and no bot token are configured', async () => {
    await seedBaseMocks(win);
    await seedDiscordMocks(win, FIRST_RUN_DISCORD_CONFIG);
    const discord = new DiscordPage(win);
    await gotoDiscord(win);

    await expect(discord.wizardHeading()).toBeVisible();
    await expect(discord.developerPortalLink()).toBeVisible();
  });

  test('should hide the setup wizard once a guild is allowlisted', async () => {
    await seedBaseMocks(win);
    await seedDiscordMocks(win, CONFIGURED_DISCORD_CONFIG);
    const discord = new DiscordPage(win);
    await gotoDiscord(win);

    await expect(discord.pageHeading()).toBeVisible();
    await expect(discord.wizardHeading()).not.toBeVisible();
  });

  test('should show the wizard when allowedGuilds is empty even if credentials are already set', async () => {
    await seedBaseMocks(win);
    await seedDiscordMocks(win, { ...CONFIGURED_DISCORD_CONFIG, allowedGuilds: [] });
    const discord = new DiscordPage(win);
    await gotoDiscord(win);

    await expect(discord.wizardHeading()).toBeVisible();
  });

  test('should render live checkmarks for satisfied wizard steps', async () => {
    // clientId set → step 1 done; botTokenSet + publicKeySet → step 2 done;
    // interactionsEndpointUrl set → step 3 done; no guilds → step 4 pending.
    await seedBaseMocks(win);
    await seedDiscordMocks(win, { ...CONFIGURED_DISCORD_CONFIG, allowedGuilds: [] });
    const discord = new DiscordPage(win);
    await gotoDiscord(win);

    await expect(discord.wizardHeading()).toBeVisible();
    // The credentials step should be struck through (done) because both secrets are set
    const credentialsStep = discord.credentialsWizardStep();
    await expect(credentialsStep).toBeVisible();
    await expect(credentialsStep).toHaveCSS('text-decoration-line', 'line-through');
  });

  test('should render the Credentials tab by default', async () => {
    await seedBaseMocks(win);
    await seedDiscordMocks(win, CONFIGURED_DISCORD_CONFIG);
    const discord = new DiscordPage(win);
    await gotoDiscord(win);

    await expect(discord.clientIdField()).toBeVisible();
    await expect(discord.saveCredentialsButton()).toBeVisible();
  });

  test('should show a "set" indicator when the bot token is already configured', async () => {
    await seedBaseMocks(win);
    await seedDiscordMocks(win, CONFIGURED_DISCORD_CONFIG);
    const discord = new DiscordPage(win);
    await gotoDiscord(win);

    // Both the green-check badge (aria-label) and the helper text render when
    // the secret is already set server-side.
    await expect(discord.alreadySetBadge()).toBeVisible();
    await expect(discord.alreadySetHelperText()).toBeVisible();
  });

  test('should toggle bot-token visibility when the eye icon is clicked', async () => {
    await seedBaseMocks(win);
    await seedDiscordMocks(win, CONFIGURED_DISCORD_CONFIG);
    const discord = new DiscordPage(win);
    await gotoDiscord(win);

    const tokenField = discord.botTokenField();
    await expect(tokenField).toHaveAttribute('type', 'password');

    await discord.showSecretButton().click();
    await expect(tokenField).toHaveAttribute('type', 'text');

    await discord.hideSecretButton().click();
    await expect(tokenField).toHaveAttribute('type', 'password');
  });

  test('should never echo the bot token or public key in the config response', async () => {
    await seedBaseMocks(win);
    await seedDiscordMocks(win, CONFIGURED_DISCORD_CONFIG);
    await gotoDiscord(win);

    // Wait for the Discord page to finish loading its config by waiting for
    // the credentials form to appear, then verify that the value returned by
    // `getConfig()` never carries the raw secrets — only boolean flags.
    const discord = new DiscordPage(win);
    await expect(discord.clientIdField()).toBeVisible();

    const configBody = await win.evaluate(async () => {
      const gsd = (window as Record<string, unknown>)['gsd'] as {
        discord: { getConfig: () => Promise<Record<string, unknown>> };
      };
      return gsd.discord.getConfig();
    });

    expect(configBody).not.toHaveProperty('botToken');
    expect(configBody).not.toHaveProperty('publicKey');
    expect(configBody).toHaveProperty('botTokenSet');
    expect(configBody).toHaveProperty('publicKeySet');
  });

  test('should switch to the Guilds tab when clicked', async () => {
    await seedBaseMocks(win);
    await seedDiscordMocks(win, CONFIGURED_DISCORD_CONFIG);
    const discord = new DiscordPage(win);
    await gotoDiscord(win);

    await discord.guildsTab().click();
    await expect(discord.addGuildInput()).toBeVisible();
  });

  test('should reject a malformed guild snowflake with an inline error', async () => {
    await seedBaseMocks(win);
    await seedDiscordMocks(win, CONFIGURED_DISCORD_CONFIG);

    // Override discord.addGuild so we can detect if it was incorrectly invoked.
    await win.evaluate((guilds) => {
      const gsd = (window as Record<string, unknown>)['gsd'] as {
        __test: { mock: (channel: string, handler: unknown) => void };
      };
      (window as Record<string, unknown>)['__discordAddGuildCalled'] = false;
      gsd.__test.mock('discord.addGuild', () => {
        (window as Record<string, unknown>)['__discordAddGuildCalled'] = true;
        return Promise.resolve({ success: true, guilds, baseGuilds: [] });
      });
    }, CONFIGURED_DISCORD_CONFIG.allowedGuilds);

    const discord = new DiscordPage(win);
    await gotoDiscord(win);
    await discord.guildsTab().click();

    await discord.addGuildInput().fill('not-a-snowflake');
    await discord.addGuildButton().click();

    await expect(discord.snowflakeValidationError()).toBeVisible();

    const addCalled = await win.evaluate(
      () => (window as Record<string, unknown>)['__discordAddGuildCalled'],
    );
    expect(addCalled).toBe(false);
  });

  test('should invoke discord.addGuild with the correct snowflake', async () => {
    await seedBaseMocks(win);
    await seedDiscordMocks(win, CONFIGURED_DISCORD_CONFIG);

    // Override discord.addGuild to capture the argument and return an updated
    // guild list, so the UI reflects the addition after refresh.
    await win.evaluate((args) => {
      const gsd = (window as Record<string, unknown>)['gsd'] as {
        __test: { mock: (channel: string, handler: unknown) => void };
      };
      (window as Record<string, unknown>)['__discordAddGuildArg'] = null;
      gsd.__test.mock('discord.addGuild', (payload: unknown) => {
        (window as Record<string, unknown>)['__discordAddGuildArg'] = (payload as { guildId: string }).guildId;
        return Promise.resolve({
          success: true,
          guilds: [...args.existingGuilds, args.newGuild],
          baseGuilds: [],
        });
      });
    }, { existingGuilds: CONFIGURED_DISCORD_CONFIG.allowedGuilds, newGuild: VALID_GUILD_ID_2 });

    const discord = new DiscordPage(win);
    await gotoDiscord(win);
    await discord.guildsTab().click();
    await discord.addGuildInput().fill(VALID_GUILD_ID_2);
    await discord.addGuildButton().click();

    await expect.poll(() =>
      win.evaluate(() => (window as Record<string, unknown>)['__discordAddGuildArg']),
    ).toEqual(VALID_GUILD_ID_2);
  });

  test('should list configured guilds in the Guilds table', async () => {
    await seedBaseMocks(win);
    await seedDiscordMocks(win, CONFIGURED_DISCORD_CONFIG);
    const discord = new DiscordPage(win);
    await gotoDiscord(win);
    await discord.guildsTab().click();

    for (const id of CONFIGURED_DISCORD_CONFIG.allowedGuilds) {
      await expect(discord.guildCell(id)).toBeVisible();
    }
  });

  test('should mark a guild as registered after a successful register-commands call', async () => {
    await seedBaseMocks(win);
    await seedDiscordMocks(win, CONFIGURED_DISCORD_CONFIG);
    const discord = new DiscordPage(win);
    await gotoDiscord(win);
    await discord.guildsTab().click();

    await expect(discord.guildRowNotRegisteredBadge(VALID_GUILD_ID)).toBeVisible();

    await discord.guildRowRegisterButton(VALID_GUILD_ID).click();

    await expect(discord.guildRowRegisteredBadge(VALID_GUILD_ID)).toBeVisible();
    await expect(discord.guildRowNotRegisteredBadge(VALID_GUILD_ID)).toHaveCount(0);
  });

  test('should reject adding a guild that is already allowlisted', async () => {
    await seedBaseMocks(win);
    await seedDiscordMocks(win, CONFIGURED_DISCORD_CONFIG);

    // Override discord.addGuild so we can detect if it was incorrectly invoked
    // when the UI should have blocked the duplicate with a client-side error.
    await win.evaluate((guilds) => {
      const gsd = (window as Record<string, unknown>)['gsd'] as {
        __test: { mock: (channel: string, handler: unknown) => void };
      };
      (window as Record<string, unknown>)['__discordAddGuildCalled'] = false;
      gsd.__test.mock('discord.addGuild', () => {
        (window as Record<string, unknown>)['__discordAddGuildCalled'] = true;
        return Promise.resolve({ success: true, guilds, baseGuilds: [] });
      });
    }, CONFIGURED_DISCORD_CONFIG.allowedGuilds);

    const discord = new DiscordPage(win);
    await gotoDiscord(win);
    await discord.guildsTab().click();

    // VALID_GUILD_ID is already in allowedGuilds — adding it again would
    // create a duplicate row with a colliding React key.
    await discord.addGuildInput().fill(VALID_GUILD_ID);
    await discord.addGuildButton().click();

    await expect(discord.alreadyAllowlistedError()).toBeVisible();

    const addCalled = await win.evaluate(
      () => (window as Record<string, unknown>)['__discordAddGuildCalled'],
    );
    expect(addCalled).toBe(false);
  });

  test('should leave a guild not-registered when register-commands fails', async () => {
    await seedBaseMocks(win);
    await seedDiscordMocks(win, CONFIGURED_DISCORD_CONFIG);

    // Override the success stub from seedDiscordMocks so the register-commands
    // IPC call rejects. Tracks the invocation so the assertion can wait until
    // after the failure resolves.
    await win.evaluate(() => {
      const gsd = (window as Record<string, unknown>)['gsd'] as {
        __test: { mock: (channel: string, handler: unknown) => void };
      };
      (window as Record<string, unknown>)['__discordRegisterCalled'] = false;
      gsd.__test.mock('discord.registerCommands', () => {
        (window as Record<string, unknown>)['__discordRegisterCalled'] = true;
        return Promise.reject(new Error('discord rejected'));
      });
    });

    const discord = new DiscordPage(win);
    await gotoDiscord(win);
    await discord.guildsTab().click();

    await expect(discord.guildRowNotRegisteredBadge(VALID_GUILD_ID)).toBeVisible();

    await discord.guildRowRegisterButton(VALID_GUILD_ID).click();

    await expect.poll(() =>
      win.evaluate(() => (window as Record<string, unknown>)['__discordRegisterCalled']),
    ).toBe(true);

    // Badge must stay in the not-registered state — the optimistic-success
    // flip would otherwise lie about a registration that never happened.
    await expect(discord.guildRowNotRegisteredBadge(VALID_GUILD_ID)).toBeVisible();
    await expect(discord.guildRowRegisteredBadge(VALID_GUILD_ID)).toHaveCount(0);
  });

  test('should render a row per game in the per-game permissions table', async () => {
    await seedBaseMocks(win, MULTI_GAME_STATUSES);
    await seedDiscordMocks(win, CONFIGURED_DISCORD_CONFIG);
    const discord = new DiscordPage(win);
    await gotoDiscord(win);
    await discord.perGamePermissionsTab().click();

    for (const s of MULTI_GAME_STATUSES) {
      await expect(discord.gamePermissionCell(s.game)).toBeVisible();
    }
  });

  test('should reset chips on a permission row after Clear', async () => {
    const withPerms: DiscordConfigRedacted = {
      ...CONFIGURED_DISCORD_CONFIG,
      gamePermissions: {
        minecraft: { userIds: [VALID_USER_ID], roleIds: [], actions: ['start'] },
      },
    };
    const withoutPerms = CONFIGURED_DISCORD_CONFIG;

    await seedBaseMocks(win, [STOPPED_GAME]);
    await seedDiscordMocks(win, withPerms);

    // Override discord.deletePermission and discord.getConfig so that once the
    // DELETE fires, the next getConfig() call returns the cleared config —
    // that is when the row's local state must reset.
    await win.evaluate(
      ({ wp, wop }) => {
        const gsd = (window as Record<string, unknown>)['gsd'] as {
          __test: { mock: (channel: string, handler: unknown) => void };
        };
        let cleared = false;
        gsd.__test.mock('discord.deletePermission', () => {
          cleared = true;
          return Promise.resolve({ success: true, permissions: wop.gamePermissions });
        });
        gsd.__test.mock('discord.getConfig', () =>
          Promise.resolve(cleared ? wop : wp),
        );
      },
      { wp: withPerms, wop: withoutPerms },
    );

    const discord = new DiscordPage(win);
    await gotoDiscord(win);
    await discord.perGamePermissionsTab().click();

    await expect(discord.permissionsRowUserId('minecraft', VALID_USER_ID)).toBeVisible();

    await discord.permissionsRowClearButton('minecraft').click();

    // Without the re-key fix, the deleted user-ID chip would linger here
    // because PermissionRow's local state is keyed only by game name.
    await expect(discord.permissionsRowUserId('minecraft', VALID_USER_ID)).toHaveCount(0);
  });

  test('should show the not-deployed empty state when discord.getConfig rejects', async () => {
    await seedBaseMocks(win, [STOPPED_GAME]);

    // Override discord.getConfig to reject — the page should surface the
    // friendly "infrastructure not deployed yet" state, just as a 404 would.
    await win.evaluate(() => {
      const gsd = (window as Record<string, unknown>)['gsd'] as {
        __test: { mock: (channel: string, handler: unknown) => void };
      };
      gsd.__test.mock('discord.getConfig', () =>
        Promise.reject(new Error('not deployed')),
      );
    });

    const discord = new DiscordPage(win);
    await gotoDiscord(win);
    await expect(discord.notDeployedMessage()).toBeVisible();
  });

  test('should show a success toast after saving credentials', async () => {
    await seedBaseMocks(win);
    await seedDiscordMocks(win, CONFIGURED_DISCORD_CONFIG);
    const discord = new DiscordPage(win);
    await gotoDiscord(win);

    // Credentials tab is the default — wait for the form to be ready.
    await expect(discord.saveCredentialsButton()).toBeVisible();
    await discord.saveCredentialsButton().click();

    const layout = new AppLayout(win);
    await expect(layout.toastMessage('Credentials saved')).toBeVisible();
  });
});
