import { Controller, Get, Param, Post } from '@nestjs/common';
import { FileManagerService } from '../services/FileManagerService.js';

/**
 * HTTP shim that exposes the ad-hoc EFS file-manager operations as plain REST
 * endpoints (`/api/files/:game`, `/api/files/:game/start`,
 * `/api/files/:game/stop`). The browser client (`api.service.ts`) and the
 * integration-test server consume these routes over HTTP; the Electron
 * main-process host uses the IPC {@link FilesController} (`@MessagePattern`)
 * handlers instead.
 *
 * Both controllers delegate to the same {@link FileManagerService} provider —
 * the heavy lifting lives in that service, not in the thin orchestration
 * duplicated here.
 */
@Controller('files')
export class FilesHttpController {
  constructor(private readonly files: FileManagerService) {}

  /** Lists the file-manager task for `game`, returning whether it is currently running with connection details if so. */
  @Get(':game')
  list(@Param('game') game: string) {
    return this.files.getStatus(game);
  }

  /** Launches an ECS task that mounts the game's EFS access point so the user can inspect/copy save data. */
  @Post(':game/start')
  start(@Param('game') game: string) {
    return this.files.start(game);
  }

  /** Stops the file-manager task for `game` (no-op if none is running). */
  @Post(':game/stop')
  stop(@Param('game') game: string) {
    return this.files.stop(game);
  }
}
