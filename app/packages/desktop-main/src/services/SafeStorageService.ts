import { Injectable } from '@nestjs/common';
import { createRequire } from 'module';
import { logger } from '../logger.js';

const _require = createRequire(import.meta.url);

/**
 * Wraps Electron's `safeStorage` API for OS-keychain-backed encryption of
 * sensitive strings (e.g. API tokens, secrets).
 *
 * When running outside an Electron process (unit tests, plain Node CI) the
 * service degrades gracefully: `encrypt()` returns the plaintext unchanged and
 * `decrypt()` returns the input unchanged, so callers need no environment
 * branching of their own.
 *
 * All four Electron-touching operations are extracted into `protected` methods
 * (`readIsElectron`, `readIsAvailable`, `encryptString`, `decryptString`) so
 * tests can stub them via `vi.spyOn` without importing the native `electron`
 * module.
 */
@Injectable()
export class SafeStorageService {
  /**
   * Returns `true` when encryption is available — i.e. the service is running
   * inside an Electron process **and** the OS keychain (Keychain, libsecret,
   * DPAPI) is unlocked and accessible.
   */
  isAvailable(): boolean {
    if (!this.readIsElectron()) return false;
    return this.readIsAvailable();
  }

  /**
   * Encrypt `plaintext` using Electron's `safeStorage.encryptString()` and
   * return the result as a base64-encoded string suitable for storage.
   *
   * Outside an Electron process the plaintext is returned unchanged and a
   * warning is emitted — this allows the service to be consumed transparently
   * in test/CI environments.
   *
   * @param plaintext - The string to encrypt.
   * @returns Base64-encoded ciphertext, or the original `plaintext` when
   *   encryption is unavailable.
   */
  encrypt(plaintext: string): string {
    if (!this.isAvailable()) {
      logger.warn('SafeStorageService: encryption not available — returning plaintext unchanged');
      return plaintext;
    }
    const buf = this.encryptString(plaintext);
    return buf.toString('base64');
  }

  /**
   * Decrypt a base64-encoded ciphertext produced by {@link encrypt} back to
   * its original plaintext using Electron's `safeStorage.decryptString()`.
   *
   * Outside an Electron process the input is returned unchanged (on the
   * assumption it was stored as plaintext by the degraded `encrypt()` path).
   *
   * @param ciphertext - Base64-encoded encrypted string, or raw plaintext when
   *   produced outside Electron.
   * @returns Decrypted plaintext, or the original `ciphertext` when decryption
   *   is unavailable.
   *
   * @remarks
   * The caller must ensure that `isAvailable()` returns the same value at
   * both write time (`encrypt`) and read time (`decrypt`). A ciphertext blob
   * written when the OS keychain was available cannot be safely round-tripped
   * if `isAvailable()` later returns `false` (e.g. keychain locked between
   * writes and reads within the same Electron process, or data shared across
   * Electron and non-Electron contexts). In that scenario `decrypt()` returns
   * the raw base64 blob unchanged — treat the output as untrusted.
   */
  decrypt(ciphertext: string): string {
    if (!this.isAvailable()) {
      return ciphertext;
    }
    const buf = Buffer.from(ciphertext, 'base64');
    return this.decryptString(buf);
  }

  /**
   * Returns `true` when `process.versions['electron']` is set, indicating the
   * service is running inside an Electron process. Extracted as a protected
   * method so tests can stub it via `vi.spyOn` without touching
   * `process.versions` directly.
   */
  protected readIsElectron(): boolean {
    return !!process.versions['electron'];
  }

  /**
   * Calls `safeStorage.isEncryptionAvailable()` and returns its result.
   * Only called after `readIsElectron()` returns `true`. Extracted as a
   * protected method so tests can stub it via `vi.spyOn`.
   */
  protected readIsAvailable(): boolean {
    const { safeStorage } = _require('electron') as {
      safeStorage: { isEncryptionAvailable(): boolean };
    };
    return safeStorage.isEncryptionAvailable();
  }

  /**
   * Calls `safeStorage.encryptString(plaintext)` and returns the resulting
   * `Buffer`. Only called after `readIsElectron()` returns `true`. Extracted
   * as a protected method so tests can stub it via `vi.spyOn`.
   *
   * @param plaintext - The string to encrypt.
   * @returns Raw encrypted bytes as a `Buffer`.
   */
  protected encryptString(plaintext: string): Buffer {
    const { safeStorage } = _require('electron') as {
      safeStorage: { encryptString(plaintext: string): Buffer };
    };
    return safeStorage.encryptString(plaintext);
  }

  /**
   * Calls `safeStorage.decryptString(buf)` and returns the decrypted string.
   * Only called after `readIsElectron()` returns `true`. Extracted as a
   * protected method so tests can stub it via `vi.spyOn`.
   *
   * @param buf - Raw encrypted bytes previously produced by `encryptString`.
   * @returns Decrypted plaintext string.
   */
  protected decryptString(buf: Buffer): string {
    const { safeStorage } = _require('electron') as {
      safeStorage: { decryptString(buf: Buffer): string };
    };
    return safeStorage.decryptString(buf);
  }
}
