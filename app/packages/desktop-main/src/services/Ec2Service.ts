import { Injectable } from '@nestjs/common';
import { EC2Client, DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { resolveAwsClientCredentialsWithSignature } from './awsCredentialSource.js';

/**
 * Thin EC2 wrapper used solely to turn an ECS task's Elastic Network
 * Interface ID into the IP address we surface to users. ECS exposes the
 * ENI attachment on the task, but not the IP — that lives on the ENI and
 * has to be resolved via the EC2 API.
 */
@Injectable()
export class Ec2Service {
  private client: EC2Client | null = null;
  private clientCacheKey: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly store: ElectronStoreService,
  ) {}

  /**
   * Lazily constructs the EC2 client, recreating it whenever the
   * freshly-resolved region or credentials signature differs from what the
   * cached client was built with — see `EcsService.getClient`'s matching doc
   * comment for why both matter.
   */
  private getClient(): EC2Client {
    const region = this.config.getRegion();
    const { credentials, signature } = resolveAwsClientCredentialsWithSignature(this.store);
    const cacheKey = `${region}::${signature}`;
    if (!this.client || this.clientCacheKey !== cacheKey) {
      this.client = new EC2Client({ region, credentials });
      this.clientCacheKey = cacheKey;
    }
    return this.client;
  }

  /**
   * Resolve the public IPv4 of a task's ENI. Returns `null` when the ENI has
   * no public association (e.g. `assignPublicIp: DISABLED`) or the describe
   * call fails — callers then show "starting" / "no IP" instead of an error.
   */
  async getPublicIp(eniId: string): Promise<string | null> {
    try {
      const resp = await this.getClient().send(
        new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eniId] }),
      );
      const ip = resp.NetworkInterfaces?.[0]?.Association?.PublicIp ?? null;
      logger.debug('Resolved public IP', { eniId, ip });
      return ip;
    } catch (err) {
      logger.error('Failed to resolve public IP', { err, eniId });
      return null;
    }
  }

  /**
   * Resolve the VPC-private IPv4 of a task's ENI. Kept separate from
   * {@link Ec2Service.getPublicIp} so callers can pick whichever addressing
   * they need (e.g. for internal-only FileBrowser access).
   */
  async getPrivateIp(eniId: string): Promise<string | null> {
    try {
      const resp = await this.getClient().send(
        new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eniId] }),
      );
      const ip = resp.NetworkInterfaces?.[0]?.PrivateIpAddress ?? null;
      logger.debug('Resolved private IP', { eniId, ip });
      return ip;
    } catch (err) {
      logger.error('Failed to resolve private IP', { err, eniId });
      return null;
    }
  }
}
