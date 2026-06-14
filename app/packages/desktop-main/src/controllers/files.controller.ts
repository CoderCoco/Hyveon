import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { FileManagerService } from '../services/FileManagerService.js';

/**
 * IPC-only controller for the ad-hoc EFS file-manager task (browse save files
 * without a running game server). Every handler is bound to an IPC channel via
 * `@MessagePattern` / `@Payload` — no HTTP routes are registered here.
 */
@Controller()
export class FilesController {
  constructor(private readonly files: FileManagerService) {}

  /** Returns whether a file-manager task is currently running for `game`, with connection details if so. */
  @MessagePattern('files.list')
  list(@Payload() game: string) {
    return this.files.getStatus(game);
  }

  /** Launches an ECS task that mounts the game's EFS access point so the user can inspect/copy save data. */
  @MessagePattern('files.start')
  start(@Payload() game: string) {
    return this.files.start(game);
  }

  /** Stops the file-manager task for `game` (no-op if none is running). */
  @MessagePattern('files.stop')
  stop(@Payload() game: string) {
    return this.files.stop(game);
  }
}
