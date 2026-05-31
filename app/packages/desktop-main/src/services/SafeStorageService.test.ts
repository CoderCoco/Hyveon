/**
 * Unit tests for SafeStorageService.
 *
 * All Electron-touching operations are stubbed via `vi.spyOn` on the
 * protected helper methods (`readIsElectron`, `readIsAvailable`,
 * `encryptString`, `decryptString`) — the native `electron` module is never
 * imported here.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SafeStorageService } from './SafeStorageService.js';
import { logger } from '../logger.js';

describe('SafeStorageService', () => {
  let service: SafeStorageService;

  beforeEach(() => {
    service = new SafeStorageService();
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // isAvailable()
  // ---------------------------------------------------------------------------

  describe('isAvailable()', () => {
    it('should return false when not running in Electron', () => {
      vi.spyOn(service as unknown as { readIsElectron(): boolean }, 'readIsElectron').mockReturnValue(false);

      expect(service.isAvailable()).toBe(false);
    });

    it('should return false when safeStorage encryption is not available', () => {
      vi.spyOn(service as unknown as { readIsElectron(): boolean }, 'readIsElectron').mockReturnValue(true);
      vi.spyOn(service as unknown as { readIsAvailable(): boolean }, 'readIsAvailable').mockReturnValue(false);

      expect(service.isAvailable()).toBe(false);
    });

    it('should return true when running in Electron and encryption is available', () => {
      vi.spyOn(service as unknown as { readIsElectron(): boolean }, 'readIsElectron').mockReturnValue(true);
      vi.spyOn(service as unknown as { readIsAvailable(): boolean }, 'readIsAvailable').mockReturnValue(true);

      expect(service.isAvailable()).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // encrypt() — non-Electron path
  // ---------------------------------------------------------------------------

  describe('encrypt() outside Electron', () => {
    /** Spy that makes the service believe it is not running inside Electron. */
    function stubNoElectron() {
      vi.spyOn(service as unknown as { readIsElectron(): boolean }, 'readIsElectron').mockReturnValue(false);
    }

    it('should return plaintext unchanged when not running in Electron', () => {
      stubNoElectron();

      expect(service.encrypt('my-secret')).toBe('my-secret');
    });

    it('should log a warning when returning plaintext unchanged', () => {
      stubNoElectron();

      service.encrypt('my-secret');

      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // encrypt() — Electron path
  // ---------------------------------------------------------------------------

  describe('encrypt() inside Electron', () => {
    /** Spy that makes the service believe it is running inside Electron. */
    function stubElectron() {
      vi.spyOn(service as unknown as { readIsElectron(): boolean }, 'readIsElectron').mockReturnValue(true);
    }

    it('should return a base64-encoded string when Electron is available', () => {
      stubElectron();
      vi.spyOn(service as unknown as { encryptString(p: string): Buffer }, 'encryptString').mockReturnValue(
        Buffer.from('encrypted'),
      );

      const result = service.encrypt('my-secret');

      expect(result).toBe(Buffer.from('encrypted').toString('base64'));
    });

    it('should pass plaintext to encryptString', () => {
      stubElectron();
      const encryptSpy = vi
        .spyOn(service as unknown as { encryptString(p: string): Buffer }, 'encryptString')
        .mockReturnValue(Buffer.from('encrypted'));

      service.encrypt('my-secret');

      expect(encryptSpy).toHaveBeenCalledWith('my-secret');
    });
  });

  // ---------------------------------------------------------------------------
  // decrypt() — non-Electron path
  // ---------------------------------------------------------------------------

  describe('decrypt() outside Electron', () => {
    it('should return the input unchanged when not running in Electron', () => {
      vi.spyOn(service as unknown as { readIsElectron(): boolean }, 'readIsElectron').mockReturnValue(false);

      const ciphertext = Buffer.from('some-data').toString('base64');
      expect(service.decrypt(ciphertext)).toBe(ciphertext);
    });
  });

  // ---------------------------------------------------------------------------
  // decrypt() — Electron path
  // ---------------------------------------------------------------------------

  describe('decrypt() inside Electron', () => {
    /** Spy that makes the service believe it is running inside Electron. */
    function stubElectron() {
      vi.spyOn(service as unknown as { readIsElectron(): boolean }, 'readIsElectron').mockReturnValue(true);
    }

    it('should decrypt base64 ciphertext back to plaintext', () => {
      stubElectron();
      vi.spyOn(service as unknown as { decryptString(b: Buffer): string }, 'decryptString').mockReturnValue('hello');

      const ciphertext = Buffer.from('encrypted').toString('base64');
      expect(service.decrypt(ciphertext)).toBe('hello');
    });

    it('should pass the decoded Buffer to decryptString', () => {
      stubElectron();
      const decryptSpy = vi
        .spyOn(service as unknown as { decryptString(b: Buffer): string }, 'decryptString')
        .mockReturnValue('hello');

      const ciphertext = Buffer.from('encrypted').toString('base64');
      service.decrypt(ciphertext);

      expect(decryptSpy).toHaveBeenCalledWith(Buffer.from(ciphertext, 'base64'));
    });
  });

  // ---------------------------------------------------------------------------
  // Round-trip
  // ---------------------------------------------------------------------------

  describe('round-trip', () => {
    it('should encrypt and decrypt back to the original value', () => {
      vi.spyOn(service as unknown as { readIsElectron(): boolean }, 'readIsElectron').mockReturnValue(true);

      // encryptString wraps the plaintext bytes in a Buffer (real encode step for testing)
      vi.spyOn(
        service as unknown as { encryptString(p: string): Buffer },
        'encryptString',
      ).mockImplementation((plaintext: string) => Buffer.from(plaintext));

      // decryptString converts the Buffer back to a string (mirrors real decode step)
      vi.spyOn(
        service as unknown as { decryptString(b: Buffer): string },
        'decryptString',
      ).mockImplementation((buf: Buffer) => buf.toString());

      const plaintext = 'super-secret-value';
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });
  });
});
