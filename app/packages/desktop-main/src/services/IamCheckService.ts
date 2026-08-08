import { Injectable } from '@nestjs/common';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { fromIni } from '@aws-sdk/credential-providers';
import { HYVEON_DEPLOY_ALL_ACTIONS } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { resolveAwsCredentialSource, type AwsCredentialSource } from './awsCredentialSource.js';
import { GUIDED_PROFILE_NAME } from './GuidedIamService.js';

/**
 * Maximum number of action names sent in a single `SimulatePrincipalPolicy`
 * request — batched at roughly 50 actions per request.
 */
const SIMULATE_BATCH_SIZE = 50;

/** Outcome of {@link IamCheckService.checkPermissions}. */
export type IamCheckStatus = 'passed' | 'missing' | 'warning';

/**
 * Which credential source produced an {@link IamCheckResult} — resolved by
 * {@link IamCheckService.classifyOrigin} from the same
 * {@link resolveAwsCredentialSource} snapshot {@link IamCheckService.checkPermissions}
 * resolves once at the top of the method:
 *
 * - `'guided'` — a key minted and rotated in by {@link GuidedIamService.rotate}
 *   (`AwsCredentialSource.kind === 'pasted'` with `profile === GUIDED_PROFILE_NAME`).
 * - `'pasted'` — a manually pasted key (`kind: 'pasted'`, any other profile name).
 * - `'profile'` — a real `~/.aws` CLI profile (`kind: 'profile'`).
 * - `'none'` — no credential source is configured yet (`kind: 'none'`), or the
 *   source could not be determined (see {@link IamCheckService.checkPermissions}).
 */
export type IamCheckOrigin = 'guided' | 'pasted' | 'profile' | 'none';

/** Result of the wizard's best-effort IAM permission dry-run. */
export interface IamCheckResult {
  status: IamCheckStatus;
  /**
   * Present when `status` is `'missing'` — a minimal pasteable IAM policy
   * JSON document covering exactly the denied actions.
   */
  policyJson?: string;
  /**
   * Present when `status` is `'warning'` — an actionable message explaining
   * why simulation itself could not run (e.g. the caller lacks
   * `iam:SimulatePrincipalPolicy`).
   */
  message?: string;
  /** Which credential source produced this result. See {@link IamCheckOrigin}. */
  origin: IamCheckOrigin;
  /**
   * `true` only when `status === 'missing'` AND `origin === 'guided'` — a
   * denied action against a guided-provisioned (mint-then-rotate) key
   * indicates a real fault (wrong account, partially-failed CloudFormation
   * stack, a denying SCP), since that permission set is known by
   * construction. Every other combination is `false`: `warning` never
   * blocks regardless of origin (simulation failure degrades to advisory),
   * and `missing` on a `profile`/`pasted`/`none` origin is advisory too — an
   * operator may deliberately run a narrower policy on those paths. This is
   * the single source of truth a caller reads to decide whether to gate
   * wizard progression; no other field or method exposes that decision.
   */
  blocking: boolean;
}

/**
 * Runs the first-run wizard's best-effort IAM permission dry-run (see
 * `openspec/changes/add-first-run-wizard`, "IAM permission simulation"
 * scenario). Resolves the caller's identity via `sts:GetCallerIdentity`,
 * then batches `iam:SimulatePrincipalPolicy` calls across the
 * `HyveonDeployAll` action set (`@hyveon/shared`'s single source of
 * truth, itself synced to `docs/docs/setup.md`). Never grants permissions —
 * denied actions are surfaced as copy-paste-able policy JSON, and a
 * simulation failure degrades to a non-blocking warning rather than an error.
 */
@Injectable()
export class IamCheckService {
  constructor(private readonly store: ElectronStoreService) {}

  /**
   * Runs the dry-run and returns a `passed` / `missing` / `warning` result.
   *
   * Resolves `region` and the active {@link AwsCredentialSource} exactly
   * once, synchronously, before any AWS call — then threads that one
   * snapshot through {@link classifyOrigin}, {@link createStsClient}, and
   * {@link createIamClient}. Doing this resolution once (rather than each of
   * those three independently re-reading `this.store` at different times) is
   * load-bearing: `this.store` can mutate mid-call — e.g. an operator
   * triggers `AwsProfileService.rotateActiveCredentials()` while this
   * method's own `await`ed `sts:GetCallerIdentity`/`iam:SimulatePrincipalPolicy`
   * calls are in flight — and without a single snapshot, the STS call, the
   * IAM call, and the returned `origin` could each end up describing a
   * *different* credential source.
   */
  async checkPermissions(): Promise<IamCheckResult> {
    logger.debug('IamCheckService.checkPermissions: running IAM permission dry-run');
    let source: AwsCredentialSource;
    try {
      source = resolveAwsCredentialSource(this.store);
    } catch (err) {
      // e.g. AwsPastedCredentialDecryptError for a corrupt stored ciphertext
      // — no source could be classified at all.
      return { status: 'warning', message: this.describeError(err), origin: 'none', blocking: false };
    }
    const origin = this.classifyOrigin(source);

    const region = this.store.get('aws')?.region;
    if (!region) {
      return {
        status: 'warning',
        message: 'Cannot run the IAM permission check: no region is configured. Complete the credentials step of the wizard first.',
        origin,
        blocking: false,
      };
    }

    let callerArn: string;
    try {
      callerArn = await this.getCallerArn(region, source);
    } catch (err) {
      const message = this.describeError(err);
      logger.warn('IamCheckService.checkPermissions: sts:GetCallerIdentity failed — degrading to a warning', {
        origin,
        error: message,
      });
      return { status: 'warning', message, origin, blocking: false };
    }

    const actions = this.actionsToCheck();
    const denied: string[] = [];
    try {
      const client = this.createIamClient(region, source);
      for (const batch of this.chunk(actions, SIMULATE_BATCH_SIZE)) {
        const response = await client.send(
          new SimulatePrincipalPolicyCommand({ PolicySourceArn: callerArn, ActionNames: [...batch] }),
        );
        for (const result of response.EvaluationResults ?? []) {
          if (result.EvalDecision !== 'allowed' && result.EvalActionName) {
            denied.push(result.EvalActionName);
          }
        }
      }
    } catch (err) {
      const message = this.describeError(err);
      logger.warn('IamCheckService.checkPermissions: iam:SimulatePrincipalPolicy failed — degrading to a warning', {
        origin,
        error: message,
      });
      return { status: 'warning', message, origin, blocking: false };
    }

    if (denied.length === 0) {
      return { status: 'passed', origin, blocking: false };
    }
    return { status: 'missing', policyJson: this.buildPolicyJson(denied), origin, blocking: origin === 'guided' };
  }

  /**
   * Classifies {@link IamCheckOrigin} from an already-resolved
   * {@link AwsCredentialSource} — pure, no store access, so every caller
   * shares the exact snapshot {@link checkPermissions} resolved once at the
   * top of the method. Classifies a `'pasted'` source further: a profile
   * name of {@link GUIDED_PROFILE_NAME} means the key came from
   * {@link GuidedIamService.rotate}, distinguishing it from a manually
   * pasted key (see `GuidedIamService`'s doc comment on `GUIDED_PROFILE_NAME`
   * for why it's a distinct name from `AwsProfileService`'s
   * `DEFAULT_PASTED_PROFILE_NAME`).
   */
  private classifyOrigin(source: AwsCredentialSource): IamCheckOrigin {
    switch (source.kind) {
      case 'none':
        return 'none';
      case 'profile':
        return 'profile';
      case 'pasted':
        return source.profile === GUIDED_PROFILE_NAME ? 'guided' : 'pasted';
    }
  }

  /**
   * The action set to simulate. Extracted as a seam (rather than referencing
   * {@link HYVEON_DEPLOY_ALL_ACTIONS} inline) so tests can substitute a
   * larger list to exercise batching without depending on the real policy's
   * size.
   */
  protected actionsToCheck(): readonly string[] {
    return HYVEON_DEPLOY_ALL_ACTIONS;
  }

  private async getCallerArn(region: string, source: AwsCredentialSource): Promise<string> {
    const client = this.createStsClient(region, source);
    const response = await client.send(new GetCallerIdentityCommand({}));
    if (!response.Arn) {
      throw new Error('sts:GetCallerIdentity did not return an ARN for the configured credentials.');
    }
    return this.toPolicySourceArn(response.Arn);
  }

  /**
   * `SimulatePrincipalPolicy`'s `PolicySourceArn` only accepts an IAM user,
   * group, or role ARN — but `sts:GetCallerIdentity` returns an STS
   * assumed-role session ARN (`arn:aws:sts::ACCOUNT:assumed-role/ROLE/SESSION`)
   * for role/SSO credentials. Convert that to the underlying IAM role ARN;
   * other ARN types (IAM user) pass through unchanged.
   */
  private toPolicySourceArn(arn: string): string {
    const match = /^arn:(aws[a-zA-Z0-9-]*):sts::(\d+):assumed-role\/(.+)\/[^/]+$/.exec(arn);
    if (!match) {
      return arn;
    }
    const [, partition, accountId, roleNameWithPath] = match;
    return `arn:${partition}:iam::${accountId}:role/${roleNameWithPath}`;
  }

  private buildPolicyJson(actions: string[]): string {
    return JSON.stringify(
      {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: actions, Resource: '*' }],
      },
      null,
      2,
    );
  }

  private *chunk<T>(items: readonly T[], size: number): Generator<readonly T[]> {
    for (let i = 0; i < items.length; i += size) {
      yield items.slice(i, i + size);
    }
  }

  private describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /**
   * Builds an STS client from an already-resolved `region`/`source` snapshot
   * — never re-reads `this.store` itself. Extracted as a protected seam so
   * tests can stub it.
   *
   * @param region - The region resolved by {@link checkPermissions}.
   * @param source - The credential source resolved by {@link checkPermissions}.
   */
  protected createStsClient(region: string, source: AwsCredentialSource): STSClient {
    return new STSClient(this.buildClientConfig(region, source));
  }

  /**
   * Builds an IAM client from the same `region`/`source` snapshot as
   * {@link createStsClient} — never re-reads `this.store` itself. Extracted
   * as a protected seam so tests can stub it.
   *
   * @param region - The region resolved by {@link checkPermissions}.
   * @param source - The credential source resolved by {@link checkPermissions}.
   */
  protected createIamClient(region: string, source: AwsCredentialSource): IAMClient {
    return new IAMClient(this.buildClientConfig(region, source));
  }

  private buildClientConfig(
    region: string,
    source: AwsCredentialSource,
  ): Pick<import('@aws-sdk/client-iam').IAMClientConfig, 'region' | 'credentials'> {
    switch (source.kind) {
      case 'none':
        return { region };
      case 'pasted':
        return {
          region,
          credentials: { accessKeyId: source.accessKeyId, secretAccessKey: source.secretAccessKey },
        };
      case 'profile':
        return { region, credentials: fromIni({ profile: source.profile }) };
    }
  }
}
