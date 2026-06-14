import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '../services/ConfigService.js';

/**
 * HTTP shim that exposes the environment metadata endpoint as a plain REST
 * route (`GET /api/env`). The browser client (`api.service.ts`) and the
 * integration-test server consume this route over HTTP; the Electron
 * main-process host uses the IPC {@link EnvController} (`@MessagePattern`)
 * handler instead.
 *
 * Both controllers delegate to the same {@link ConfigService} provider — the
 * heavy lifting lives in that service, not in the thin orchestration
 * duplicated here.
 */
@Controller('env')
export class EnvHttpController {
  constructor(private readonly config: ConfigService) {}

  /**
   * Returns environment context derived from Terraform outputs. The UI uses
   * this to show the active region + environment label in the top bar.
   */
  @Get()
  getEnv(): { region: string; domain: string; environment: string } {
    const outputs = this.config.getTfOutputs();
    const region = outputs?.aws_region ?? 'local';
    const domain = outputs?.domain_name ?? '';

    // Derive environment label from domain or fall back to 'local'
    // This is purely cosmetic for the UI — not a security gate
    const environment = domain ? 'PROD' : 'local';

    return { region, domain, environment };
  }
}
