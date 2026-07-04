/**
 * Tests for the DynamoDB + Secrets Manager-backed DiscordConfigService.
 *
 * The service is a thin wrapper around `@hyveon/shared/ddb/configStore` and a
 * constructor-injected `SecretsStore` (`AwsSecretsStore` in production, a
 * stub here) — the stores themselves have their own tests under the shared /
 * cloud-aws packages. Here we validate the wiring: that the right stores get
 * called with the right args, that the redacted view strips both secrets,
 * and that the controller-facing contract (same method names as the old
 * file-backed service) still behaves.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretsStore } from '@hyveon/shared';
import { DiscordConfigService } from './DiscordConfigService.js';
import { ConfigService, type TfOutputs } from './ConfigService.js';

const getDiscordConfigMock = vi.fn();
const getBaseDiscordConfigMock = vi.fn();
const putDiscordConfigMock = vi.fn();

vi.mock('@hyveon/shared', async () => {
  const actual = await vi.importActual<typeof import('@hyveon/shared')>('@hyveon/shared');
  return {
    ...actual,
    getDiscordConfig: (...args: unknown[]) => getDiscordConfigMock(...args),
    getBaseDiscordConfig: (...args: unknown[]) => getBaseDiscordConfigMock(...args),
    putDiscordConfig: (...args: unknown[]) => putDiscordConfigMock(...args),
  };
});

/** Minimal `TfOutputs` stub exposing just the Discord-store fields. */
const TF: TfOutputs = {
  aws_region: 'us-east-1',
  ecs_cluster_name: '',
  ecs_cluster_arn: '',
  subnet_ids: '',
  security_group_id: '',
  file_manager_security_group_id: '',
  efs_file_system_id: '',
  efs_access_points: {},
  domain_name: '',
  game_names: [],
  alb_dns_name: null,
  acm_certificate_arn: null,
  discord_table_name: 'test-discord',
  discord_bot_token_secret_arn: 'arn:bot-token',
  discord_public_key_secret_arn: 'arn:public-key',
  interactions_invoke_url: 'https://url',
};

/** `get` mock for the injected `SecretsStore` stub — keyed by secret name/ARN so bot-token and public-key lookups can be stubbed independently. */
const secretsGetMock = vi.fn<SecretsStore['get']>();
const secretsPutMock = vi.fn<SecretsStore['put']>();
const secretsExistsMock = vi.fn<SecretsStore['exists']>();

/** Builds a `SecretsStore`-shaped stub backed by the shared mocks above. */
function makeSecretsStore(): SecretsStore {
  return { get: secretsGetMock, put: secretsPutMock, exists: secretsExistsMock };
}

function makeService(
  outputs: TfOutputs | null = TF,
  secrets: SecretsStore = makeSecretsStore(),
): DiscordConfigService {
  const config = { getTfOutputs: () => outputs } as Partial<ConfigService> as ConfigService;
  return new DiscordConfigService(config, secrets);
}

beforeEach(() => {
  getDiscordConfigMock.mockReset();
  getBaseDiscordConfigMock.mockReset();
  putDiscordConfigMock.mockReset();
  secretsGetMock.mockReset();
  secretsPutMock.mockReset();
  secretsExistsMock.mockReset();
  getDiscordConfigMock.mockResolvedValue({
    clientId: '',
    allowedGuilds: [],
    admins: { userIds: [], roleIds: [] },
    gamePermissions: {},
  });
  getBaseDiscordConfigMock.mockResolvedValue({
    allowedGuilds: [],
    admins: { userIds: [], roleIds: [] },
  });
  putDiscordConfigMock.mockResolvedValue(undefined);
  secretsGetMock.mockResolvedValue(undefined);
  secretsPutMock.mockResolvedValue(undefined);
});

describe('DiscordConfigService construction', () => {
  it('should return an empty config when Terraform outputs are missing rather than crash the request', async () => {
    // `load()` catches the "table name missing" error so a freshly-cloned
    // repo where `terraform apply` hasn't run can still render the web UI
    // (with empty config) instead of 500ing on every Discord controller call.
    const svc = makeService(null);
    const cfg = await svc.getConfig();
    expect(cfg).toEqual({
      clientId: '',
      allowedGuilds: [],
      admins: { userIds: [], roleIds: [] },
      gamePermissions: {},
    });
    expect(getDiscordConfigMock).not.toHaveBeenCalled();
  });
});

describe('DiscordConfigService.getRedacted', () => {
  it('should indicate when both secrets are configured and return the DDB config body', async () => {
    getDiscordConfigMock.mockResolvedValue({
      clientId: 'client-xyz',
      allowedGuilds: ['G1'],
      admins: { userIds: ['U1'], roleIds: [] },
      gamePermissions: {},
    });
    secretsGetMock.mockImplementation(async (name: string) => {
      if (name === 'arn:bot-token') return 'real-token';
      if (name === 'arn:public-key') return 'hex-key';
      return undefined;
    });

    const redacted = await makeService().getRedacted();

    expect(redacted).toMatchObject({
      clientId: 'client-xyz',
      allowedGuilds: ['G1'],
      botTokenSet: true,
      publicKeySet: true,
    });
    expect(redacted).not.toHaveProperty('botToken');
    expect(redacted).not.toHaveProperty('publicKey');
    expect(secretsGetMock).toHaveBeenCalledWith('arn:bot-token');
    expect(secretsGetMock).toHaveBeenCalledWith('arn:public-key');
  });

  it('should flag both secrets as unset when they still hold the placeholder', async () => {
    secretsGetMock.mockResolvedValue(undefined);
    const redacted = await makeService().getRedacted();
    expect(redacted.botTokenSet).toBe(false);
    expect(redacted.publicKeySet).toBe(false);
  });

  it('should include base guild and admin lists from the BASE#discord row', async () => {
    getBaseDiscordConfigMock.mockResolvedValue({
      allowedGuilds: ['G-base'],
      admins: { userIds: ['U-base'], roleIds: ['R-base'] },
    });
    const redacted = await makeService().getRedacted();
    expect(redacted.baseAllowedGuilds).toEqual(['G-base']);
    expect(redacted.baseAdmins).toEqual({ userIds: ['U-base'], roleIds: ['R-base'] });
  });

  it('should return empty base lists when no BASE#discord row exists', async () => {
    getBaseDiscordConfigMock.mockResolvedValue({ allowedGuilds: [], admins: { userIds: [], roleIds: [] } });
    const redacted = await makeService().getRedacted();
    expect(redacted.baseAllowedGuilds).toEqual([]);
    expect(redacted.baseAdmins).toEqual({ userIds: [], roleIds: [] });
  });
});

describe('DiscordConfigService.setCredentials', () => {
  it('should route clientId to DynamoDB and both secrets to Secrets Manager', async () => {
    const svc = makeService();
    const ok = await svc.setCredentials({ clientId: 'abc', botToken: 'tok', publicKey: 'hex' });
    expect(ok).toBe(true);
    expect(putDiscordConfigMock).toHaveBeenCalledWith(
      'test-discord',
      expect.objectContaining({ clientId: 'abc' }),
    );
    expect(secretsPutMock).toHaveBeenCalledWith('arn:bot-token', 'tok');
    expect(secretsPutMock).toHaveBeenCalledWith('arn:public-key', 'hex');
  });

  it('should reject non-string inputs without writing anything', async () => {
    const svc = makeService();
    const ok = await svc.setCredentials({ clientId: 42 });
    expect(ok).toBe(false);
    expect(putDiscordConfigMock).not.toHaveBeenCalled();
    expect(secretsPutMock).not.toHaveBeenCalled();
  });

  it('should leave a field unchanged when its key is omitted from the body', async () => {
    const svc = makeService();
    await svc.setCredentials({ publicKey: 'hex' });
    expect(secretsPutMock).toHaveBeenCalledWith('arn:public-key', 'hex');
    expect(secretsPutMock).not.toHaveBeenCalledWith('arn:bot-token', expect.anything());
    expect(putDiscordConfigMock).not.toHaveBeenCalled();
  });

  it('should skip Secrets Manager writes when a token field is an empty string', async () => {
    const svc = makeService();
    await svc.setCredentials({ botToken: '' });
    expect(secretsPutMock).not.toHaveBeenCalled();
  });
});

describe('DiscordConfigService.allowedGuilds mutations', () => {
  it('should add a guild idempotently (no-op if already present)', async () => {
    getDiscordConfigMock.mockResolvedValue({
      clientId: '',
      allowedGuilds: ['G1'],
      admins: { userIds: [], roleIds: [] },
      gamePermissions: {},
    });
    const svc = makeService();
    await svc.addAllowedGuild('G1');
    expect(putDiscordConfigMock).not.toHaveBeenCalled();
  });

  it('should persist an added guild when it is new', async () => {
    const svc = makeService();
    await svc.addAllowedGuild('G2');
    expect(putDiscordConfigMock).toHaveBeenCalledWith(
      'test-discord',
      expect.objectContaining({ allowedGuilds: ['G2'] }),
    );
  });

  it('should remove a guild from the dynamic allowlist and return ok', async () => {
    getDiscordConfigMock.mockResolvedValue({
      clientId: '',
      allowedGuilds: ['G1', 'G2'],
      admins: { userIds: [], roleIds: [] },
      gamePermissions: {},
    });
    const svc = makeService();
    const result = await svc.removeAllowedGuild('G1');
    expect(result).toEqual({ ok: true });
    expect(putDiscordConfigMock).toHaveBeenCalledWith(
      'test-discord',
      expect.objectContaining({ allowedGuilds: ['G2'] }),
    );
  });

  it('should refuse to remove a guild that is in the Terraform base config', async () => {
    getBaseDiscordConfigMock.mockResolvedValue({
      allowedGuilds: ['G-base'],
      admins: { userIds: [], roleIds: [] },
    });
    const svc = makeService();
    const result = await svc.removeAllowedGuild('G-base');
    expect(result).toMatchObject({ ok: false });
    expect(putDiscordConfigMock).not.toHaveBeenCalled();
  });

  it('should dedupe and drop empty strings when setAllowedGuilds is called', async () => {
    const svc = makeService();
    await svc.setAllowedGuilds(['G1', '', 'G1', 'G2']);
    expect(putDiscordConfigMock).toHaveBeenCalledWith(
      'test-discord',
      expect.objectContaining({ allowedGuilds: ['G1', 'G2'] }),
    );
  });
});

describe('DiscordConfigService.setGamePermission', () => {
  it('should persist a sanitized permission entry for a known game', async () => {
    const svc = makeService();
    const ok = await svc.setGamePermission('palworld', {
      userIds: ['U1'],
      roleIds: ['R1'],
      actions: ['start', 'nope'],
    });
    expect(ok).toBe(true);
    expect(putDiscordConfigMock).toHaveBeenCalledWith(
      'test-discord',
      expect.objectContaining({
        gamePermissions: { palworld: { userIds: ['U1'], roleIds: ['R1'], actions: ['start'] } },
      }),
    );
  });

  it('should reject prototype-pollution game keys without writing', async () => {
    const svc = makeService();
    const ok = await svc.setGamePermission('__proto__', { userIds: [], roleIds: [], actions: [] });
    expect(ok).toBe(false);
    expect(putDiscordConfigMock).not.toHaveBeenCalled();
  });
});

describe('DiscordConfigService.deleteGamePermission', () => {
  it('should remove the entry and persist the updated config', async () => {
    getDiscordConfigMock.mockResolvedValue({
      clientId: '',
      allowedGuilds: [],
      admins: { userIds: [], roleIds: [] },
      gamePermissions: {
        palworld: { userIds: ['U1'], roleIds: [], actions: ['start'] },
      },
    });
    const svc = makeService();
    const ok = await svc.deleteGamePermission('palworld');
    expect(ok).toBe(true);
    expect(putDiscordConfigMock).toHaveBeenCalledWith(
      'test-discord',
      expect.objectContaining({ gamePermissions: {} }),
    );
  });

  it('should refuse to delete with an unsafe key', async () => {
    const svc = makeService();
    const ok = await svc.deleteGamePermission('constructor');
    expect(ok).toBe(false);
    expect(putDiscordConfigMock).not.toHaveBeenCalled();
  });
});
