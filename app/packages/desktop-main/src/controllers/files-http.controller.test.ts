import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { FilesHttpController } from './files-http.controller.js';
import type { FileManagerService } from '../services/FileManagerService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Build a FileManagerService stub with all methods wired to succeed. */
function makeFiles(): FileManagerService {
  return {
    getStatus: vi.fn().mockResolvedValue({ game: 'minecraft', state: 'stopped' }),
    start: vi.fn().mockResolvedValue({ success: true, message: 'Task launched' }),
    stop: vi.fn().mockResolvedValue({ success: true, message: 'Task stopped' }),
  } as unknown as FileManagerService;
}

describe('FilesHttpController', () => {
  describe('getStatus', () => {
    it('should delegate to FileManagerService.getStatus with the requested game', async () => {
      const files = makeFiles();
      await new FilesHttpController(files).getStatus('minecraft');
      expect(files.getStatus).toHaveBeenCalledWith('minecraft');
    });

    it('should return whatever FileManagerService.getStatus returns', async () => {
      const files = makeFiles();
      vi.mocked(files.getStatus).mockResolvedValue({ game: 'minecraft', state: 'running', url: 'http://1.2.3.4:8080' });
      const result = await new FilesHttpController(files).getStatus('minecraft');
      expect(result).toMatchObject({ state: 'running', url: 'http://1.2.3.4:8080' });
    });
  });

  describe('start', () => {
    it('should delegate to FileManagerService.start with the requested game', async () => {
      const files = makeFiles();
      await new FilesHttpController(files).start('palworld');
      expect(files.start).toHaveBeenCalledWith('palworld');
    });

    it('should return the result from FileManagerService.start', async () => {
      const result = await new FilesHttpController(makeFiles()).start('minecraft');
      expect(result).toMatchObject({ success: true, message: 'Task launched' });
    });
  });

  describe('stop', () => {
    it('should delegate to FileManagerService.stop with the requested game', async () => {
      const files = makeFiles();
      await new FilesHttpController(files).stop('minecraft');
      expect(files.stop).toHaveBeenCalledWith('minecraft');
    });

    it('should return the result from FileManagerService.stop', async () => {
      const result = await new FilesHttpController(makeFiles()).stop('minecraft');
      expect(result).toMatchObject({ success: true, message: 'Task stopped' });
    });
  });
});
