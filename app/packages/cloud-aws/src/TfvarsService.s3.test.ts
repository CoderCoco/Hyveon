/**
 * S3-path tests for `TfvarsService`, exercised against the real
 * `AwsRemoteFileStore` (rather than a hand-rolled `RemoteFileStore` stub) with
 * the underlying `S3Client` intercepted via `aws-sdk-client-mock`. This proves
 * the S3 mode wiring end-to-end: `TfvarsService` resolves a bucket from
 * `ConfigService`, delegates to `AwsRemoteFileStore.get()`, which in turn
 * issues a real `GetObjectCommand` against the mocked S3 client — mirroring
 * `AwsRemoteFileStore.test.ts`'s use of `mockClient(S3Client)`.
 *
 * This spec lives in `packages/cloud-aws` (rather than alongside
 * `TfvarsService` in `packages/desktop-main`) because the ESLint
 * `no-restricted-imports` rule only allows direct `@aws-sdk/*` imports within
 * `packages/cloud-aws/**` and `packages/lambda/**` — see `eslint.config.js`.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { AwsRemoteFileStore } from './AwsRemoteFileStore.js';
import { TfvarsService } from '../../desktop-main/src/services/TfvarsService.js';
import type { ConfigService } from '../../desktop-main/src/services/ConfigService.js';

/** Typed stand-in for the AWS S3 SDK client, shared across the tests below. */
const s3Mock = mockClient(S3Client);

/** A minimal, valid `terraform.tfvars` fixture defining a single game server. */
const FIXTURE_TFVARS = `
aws_region   = "us-east-1"
project_name = "game-servers"

game_servers = {
  palworld = {
    image  = "thijsvanloef/palworld-server-docker:latest"
    cpu    = 2048
    memory = 8192
    ports = [
      { container = 8211,  protocol = "udp" },
    ]
    environment = [
      { name = "PLAYERS", value = "16" },
    ]
    volumes = [
      { name = "saves", container_path = "/palworld" },
    ]
    https           = false
    connect_message = "Connect to {host}:{port}"
  }
}
`;

/** Builds a fake S3 `Body` stream whose `transformToByteArray()` resolves to the given bytes. */
function fakeBody(bytes: Uint8Array): { transformToByteArray: () => Promise<Uint8Array> } {
  return { transformToByteArray: async () => bytes };
}

/**
 * Builds a `ConfigService` stub exposing just the methods `TfvarsService`
 * reads: a configured S3 bucket (selecting S3 mode) and a tfvars path whose
 * basename becomes the S3 object key.
 */
function makeConfig(opts: { bucket: string; path?: string }): ConfigService {
  const stub: Partial<ConfigService> = {
    getTfvarsBucket: () => opts.bucket,
    getTfvarsPath: () => opts.path ?? '/repo/terraform/terraform.tfvars',
    readEnvTfvarsCacheTtlMs: () => 30000,
  };
  return stub as ConfigService;
}

describe('TfvarsService (S3 path, real AwsRemoteFileStore)', () => {
  beforeEach(() => {
    s3Mock.reset();
  });

  it('should issue a GetObjectCommand for the tfvars basename against the configured bucket', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: fakeBody(new TextEncoder().encode(FIXTURE_TFVARS)) as never,
      ETag: '"etag-1"',
    });

    const remoteFileStore = new AwsRemoteFileStore(() => ({ bucket: 'my-tfvars-bucket' }));
    const service = new TfvarsService(
      makeConfig({ bucket: 'my-tfvars-bucket', path: '/repo/terraform/terraform.tfvars' }),
      remoteFileStore,
    );

    const result = await service.getGameServers();

    expect(result).toEqual([
      {
        name: 'palworld',
        image: 'thijsvanloef/palworld-server-docker:latest',
        cpu: 2048,
        memory: 8192,
        ports: [{ container: 8211, protocol: 'udp' }],
        environment: [{ name: 'PLAYERS', value: '16' }],
        volumes: [{ name: 'saves', container_path: '/palworld' }],
        https: false,
        connect_message: 'Connect to {host}:{port}',
      },
    ]);

    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
    const input = s3Mock.commandCalls(GetObjectCommand)[0]!.args[0].input;
    expect(input.Bucket).toBe('my-tfvars-bucket');
    expect(input.Key).toBe('terraform.tfvars');
  });

  it('should return an empty array and not throw when the S3 object does not exist', async () => {
    s3Mock.on(GetObjectCommand).resolves({});

    const remoteFileStore = new AwsRemoteFileStore(() => ({ bucket: 'my-tfvars-bucket' }));
    const service = new TfvarsService(makeConfig({ bucket: 'my-tfvars-bucket' }), remoteFileStore);

    await expect(service.getGameServers()).resolves.toEqual([]);
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
  });
});
