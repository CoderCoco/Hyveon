import { Injectable } from '@nestjs/common';
import Store from 'electron-store';
import { logger } from '../logger.js';
import { SafeStorageService } from './SafeStorageService.js';

/**
 * Typed schema for the application's persistent electron-store.
 *
 * Secret fields (`aws.accessKeyId`, `aws.secretAccessKey`) are stored
 * encrypted via {@link SafeStorageService} and must never be read or written
 * directly — always use {@link ElectronStoreService.getSecretAccessKeyId},
 * {@link ElectronStoreService.setSecretAccessKeyId},
 * {@link ElectronStoreService.getSecretAccessKey}, and
 * {@link ElectronStoreService.setSecretAccessKey}.
 */
export interface AppStoreSchema {
  wizardCompleted: boolean;
  /** Locked to `'aws'` for v1. */
  activeCloud: 'aws';
  aws: {
    region?: string;
    profile?: string;
    /** Stored as an encrypted base64 blob — do not read this field directly. */
    accessKeyId?: string;
    /** Stored as an encrypted base64 blob — do not read this field directly. */
    secretAccessKey?: string;
  };
}

/**
 * Wraps `electron-store` with a typed {@link AppStoreSchema} and provides
 * transparent encryption of secret fields via {@link SafeStorageService}.
 *
 * When running outside an Electron process (unit tests, CI) the service uses a
 * `Map<string, unknown>` as an in-memory backing store — the public API surface
 * is identical, but reads/writes do not persist across process restarts.
 *
 * Protected methods (`createStore`, `readIsElectron`) are extracted so tests
 * can stub them via `vi.spyOn` without importing native Electron modules.
 */
@Injectable()
export class ElectronStoreService {
  private readonly _store: Store<AppStoreSchema> | null;
  private readonly _map: Map<string, unknown> | null;

  constructor(private readonly safeStorage: SafeStorageService) {
    if (this.readIsElectron()) {
      this._store = this.createStore();
      this._map = null;
    } else {
      this._store = null;
      this._map = new Map();
    }
  }

  /**
   * Returns `true` when running inside an Electron process — i.e. the store is
   * backed by a real disk file in the user-data directory.
   */
  isElectron(): boolean {
    return this.readIsElectron();
  }

  /**
   * Read a top-level key from the store.
   *
   * @param key - One of the top-level keys defined in {@link AppStoreSchema}.
   * @returns The stored value, or `undefined` if the key has not been set.
   */
  get<K extends keyof AppStoreSchema>(key: K): AppStoreSchema[K] | undefined {
    if (this._store !== null) {
      return this._store.get(key) as AppStoreSchema[K] | undefined;
    }
    return this._map!.get(key) as AppStoreSchema[K] | undefined;
  }

  /**
   * Write a top-level key to the store.
   *
   * @param key - One of the top-level keys defined in {@link AppStoreSchema}.
   * @param value - The value to persist.
   */
  set<K extends keyof AppStoreSchema>(key: K, value: AppStoreSchema[K]): void {
    if (this._store !== null) {
      this._store.set(key, value);
    } else {
      this._map!.set(key, value);
    }
  }

  /**
   * Read `aws.accessKeyId`, decrypting the stored blob via
   * {@link SafeStorageService}.
   *
   * @returns The decrypted access key ID, or `undefined` if not stored.
   */
  getSecretAccessKeyId(): string | undefined {
    const aws = this.get('aws');
    if (aws?.accessKeyId === undefined) return undefined;
    return this.safeStorage.decrypt(aws.accessKeyId);
  }

  /**
   * Write `aws.accessKeyId`, encrypting the value via {@link SafeStorageService}
   * before storage.  Merges with the existing `aws` object so other fields are
   * preserved.
   *
   * @param value - Plaintext access key ID to encrypt and store.
   */
  setSecretAccessKeyId(value: string): void {
    const encrypted = this.safeStorage.encrypt(value);
    const current = this.get('aws') ?? {};
    this.set('aws', { ...current, accessKeyId: encrypted });
    logger.debug('ElectronStoreService: aws.accessKeyId written (encrypted)');
  }

  /**
   * Read `aws.secretAccessKey`, decrypting the stored blob via
   * {@link SafeStorageService}.
   *
   * @returns The decrypted secret access key, or `undefined` if not stored.
   */
  getSecretAccessKey(): string | undefined {
    const aws = this.get('aws');
    if (aws?.secretAccessKey === undefined) return undefined;
    return this.safeStorage.decrypt(aws.secretAccessKey);
  }

  /**
   * Write `aws.secretAccessKey`, encrypting the value via
   * {@link SafeStorageService} before storage.  Merges with the existing `aws`
   * object so other fields are preserved.
   *
   * @param value - Plaintext secret access key to encrypt and store.
   */
  setSecretAccessKey(value: string): void {
    const encrypted = this.safeStorage.encrypt(value);
    const current = this.get('aws') ?? {};
    this.set('aws', { ...current, secretAccessKey: encrypted });
    logger.debug('ElectronStoreService: aws.secretAccessKey written (encrypted)');
  }

  /**
   * Constructs the underlying `electron-store` instance.  Called once in the
   * constructor when running inside Electron. Extracted as a protected method
   * so tests can stub it via `vi.spyOn` to avoid touching the real user-data
   * directory.
   */
  protected createStore(): Store<AppStoreSchema> {
    return new Store<AppStoreSchema>({ name: 'electron-store' });
  }

  /**
   * Returns `true` when `process.versions['electron']` is set, indicating this
   * process is running inside Electron.  Extracted as a protected method so
   * tests can stub it via `vi.spyOn` without mutating `process.versions`.
   */
  protected readIsElectron(): boolean {
    return !!process.versions['electron'];
  }
}
