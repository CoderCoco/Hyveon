import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { logger } from '../logger.js';
import { ConfigService } from '../services/ConfigService.js';

/**
 * Global guard that gates every request behind a bearer token.
 *
 * The token is resolved **on every request** via {@link ConfigService.getApiToken}
 * so rotating the token (e.g. by editing `server_config.json`) takes effect
 * without a server restart.
 *
 * Behavior:
 * - `getApiToken()` returns `null` → the app has no token configured. Logs a
 *   warning once and allows the request through (dev convenience). This is
 *   only reachable in production when the startup check in `main.ts` has
 *   been bypassed deliberately; normally production boot refuses to start.
 * - `getApiToken()` returns a string → require an `Authorization: Bearer <token>`
 *   header whose token matches exactly. A timing-safe comparison isn't used
 *   because the token lives on the local dashboard and the risk model doesn't
 *   include a timing-side-channel attacker; simple string equality keeps the
 *   code readable.
 *
 * Missing/malformed headers → 401. Mismatched token → 401.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  private warnedUnauthenticated = false;

  constructor(private readonly config: ConfigService) {}

  /**
   * Nest invokes this for every `/api/*` request. Returns `true` to allow,
   * throws `UnauthorizedException` to reject. Dev convenience: when no token
   * is configured we log once and let the request through — production boot
   * refuses to start in that state, so this branch is dev-only in practice.
   */
  canActivate(context: ExecutionContext): boolean {
    // IPC microservice calls arrive as 'rpc' context — no HTTP headers to check.
    if (context.getType() !== 'http') {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const configured = this.config.getApiToken();

    if (!configured) {
      if (!this.warnedUnauthenticated) {
        logger.warn(
          'API_TOKEN is not configured — /api/* is accepting UNAUTHENTICATED requests. ' +
            'Set the API_TOKEN env var or api_token in server_config.json for production use.',
        );
        this.warnedUnauthenticated = true;
      }
      return true;
    }

    // Prefer the Authorization header; fall back to ?token= query param for
    // SSE endpoints where the browser's native EventSource cannot set headers.
    const header = req.headers['authorization'];
    let presented: string;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      presented = header.slice('Bearer '.length).trim();
    } else {
      const queryToken = (req.query as Record<string, unknown> | undefined)?.['token'];
      if (typeof queryToken !== 'string') {
        throw new UnauthorizedException({ error: 'missing bearer token' });
      }
      // Remove the token from req.query so RequestLoggerMiddleware doesn't
      // log it — the finish handler fires after this guard runs.
      delete (req.query as Record<string, unknown>)['token'];
      presented = queryToken;
    }
    if (presented !== configured) {
      logger.warn('Rejected /api request with bad bearer token', {
        path: req.path,
        method: req.method,
      });
      throw new UnauthorizedException({ error: 'invalid bearer token' });
    }
    return true;
  }
}
