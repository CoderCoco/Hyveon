/**
 * Unit tests for ElectronStoreService.
 *
 * `electron-store` is mocked at the module level so no real disk I/O or
 * Electron native modules are ever touched.  Protected methods
 * (`readIsElectron`, `createStore`) are stubbed via `vi.spyOn` on the
 * prototype before each Electron-path construction so the constructor takes
 * the right branch.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Store from 'electron-store';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('electron-store', () => {
  const MockStore = vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    set: vi.fn(),
  }));
  return { default: MockStore };
});

import { ElectronStoreService, type AppStoreSchema } from './ElectronStoreService.js';
import { SafeStorageService } from './SafeStorageService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a `SafeStorageService` whose `encrypt` / `decrypt` methods are
 * identity functions by default (outside-Electron degraded path).
 */
function makeSafeStorage(): SafeStorageService {
  return new SafeStorageService();
}

/**
 * Builds a minimal mock `Store<AppStoreSchema>` compatible with what
 * `ElectronStoreService` calls on it.
 */
function makeMockStore(): Store<AppStoreSchema> {
  return {
    get: vi.fn(),
    set: vi.fn(),
  } as unknown as Store<AppStoreSchema>;
}

// ---------------------------------------------------------------------------
// Non-Electron path (Map fallback)
// ---------------------------------------------------------------------------

describe('ElectronStoreService — non-Electron path (Map fallback)', () => {
  let service: ElectronStoreService;
  let safeStorage: SafeStorageService;

  beforeEach(() => {
    safeStorage = makeSafeStorage();
    // process.versions['electron'] is not set in Vitest/Node, so the Map
    // fallback is used automatically — no spy needed.
    service = new ElectronStoreService(safeStorage);
    vi.clearAllMocks();
  });

  it('should use Map fallback when not running in Electron', () => {
    expect(service.isElectron()).toBe(false);
    expect(service.get('wizardCompleted')).toBeUndefined();
  });

  it('should store and retrieve a value in Map fallback', () => {
    service.set('wizardCompleted', true);

    expect(service.get('wizardCompleted')).toBe(true);
  });

  it('should store and retrieve a nested object in Map fallback', () => {
    const awsValue: AppStoreSchema['aws'] = { region: 'us-east-1', profile: 'default' };
    service.set('aws', awsValue);

    expect(service.get('aws')).toEqual(awsValue);
  });
});

// ---------------------------------------------------------------------------
// Electron path (mocked Store)
// ---------------------------------------------------------------------------

describe('ElectronStoreService — Electron path (mocked Store)', () => {
  let service: ElectronStoreService;
  let safeStorage: SafeStorageService;
  let mockStore: Store<AppStoreSchema>;

  beforeEach(() => {
    safeStorage = makeSafeStorage();
    mockStore = makeMockStore();

    // Stub prototype BEFORE construction so the constructor takes the Electron branch.
    vi.spyOn(
      ElectronStoreService.prototype as unknown as { readIsElectron(): boolean },
      'readIsElectron',
    ).mockReturnValue(true);
    vi.spyOn(
      ElectronStoreService.prototype as unknown as { createStore(): Store<AppStoreSchema> },
      'createStore',
    ).mockReturnValue(mockStore);

    service = new ElectronStoreService(safeStorage);
    vi.clearAllMocks();
  });

  it('should call store.get when running in Electron', () => {
    (mockStore.get as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const result = service.get('wizardCompleted');

    expect(mockStore.get).toHaveBeenCalledWith('wizardCompleted');
    expect(result).toBe(true);
  });

  it('should call store.set when running in Electron', () => {
    service.set('wizardCompleted', true);

    expect(mockStore.set).toHaveBeenCalledWith('wizardCompleted', true);
  });
});

// ---------------------------------------------------------------------------
// Secret field — setSecretAccessKeyId / getSecretAccessKeyId
// ---------------------------------------------------------------------------

describe('ElectronStoreService — setSecretAccessKeyId / getSecretAccessKeyId', () => {
  let service: ElectronStoreService;
  let safeStorage: SafeStorageService;

  beforeEach(() => {
    safeStorage = makeSafeStorage();
    service = new ElectronStoreService(safeStorage);
    vi.clearAllMocks();
  });

  it('should encrypt accessKeyId before storing', () => {
    vi.spyOn(safeStorage, 'encrypt').mockReturnValue('enc-key-id');

    service.setSecretAccessKeyId('AKID123');

    expect(safeStorage.encrypt).toHaveBeenCalledWith('AKID123');
    const stored = service.get('aws');
    expect(stored?.accessKeyId).toBe('enc-key-id');
  });

  it('should decrypt accessKeyId when reading', () => {
    service.set('aws', { region: 'us-east-1', profile: 'default', accessKeyId: 'enc-key-id' });
    vi.spyOn(safeStorage, 'decrypt').mockReturnValue('AKID123');

    const result = service.getSecretAccessKeyId();

    expect(safeStorage.decrypt).toHaveBeenCalledWith('enc-key-id');
    expect(result).toBe('AKID123');
  });

  it('should return undefined for accessKeyId when not stored', () => {
    expect(service.getSecretAccessKeyId()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Secret field — setSecretAccessKey / getSecretAccessKey
// ---------------------------------------------------------------------------

describe('ElectronStoreService — setSecretAccessKey / getSecretAccessKey', () => {
  let service: ElectronStoreService;
  let safeStorage: SafeStorageService;

  beforeEach(() => {
    safeStorage = makeSafeStorage();
    service = new ElectronStoreService(safeStorage);
    vi.clearAllMocks();
  });

  it('should encrypt secretAccessKey before storing', () => {
    vi.spyOn(safeStorage, 'encrypt').mockReturnValue('enc-secret-key');

    service.setSecretAccessKey('MY_SECRET');

    expect(safeStorage.encrypt).toHaveBeenCalledWith('MY_SECRET');
    const stored = service.get('aws');
    expect(stored?.secretAccessKey).toBe('enc-secret-key');
  });

  it('should decrypt secretAccessKey when reading', () => {
    service.set('aws', { region: 'us-east-1', profile: 'default', secretAccessKey: 'enc-secret-key' });
    vi.spyOn(safeStorage, 'decrypt').mockReturnValue('MY_SECRET');

    const result = service.getSecretAccessKey();

    expect(safeStorage.decrypt).toHaveBeenCalledWith('enc-secret-key');
    expect(result).toBe('MY_SECRET');
  });

  it('should return undefined for secretAccessKey when not stored', () => {
    expect(service.getSecretAccessKey()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('ElectronStoreService — round-trip', () => {
  let service: ElectronStoreService;
  let safeStorage: SafeStorageService;

  beforeEach(() => {
    safeStorage = makeSafeStorage();
    service = new ElectronStoreService(safeStorage);
    vi.clearAllMocks();
  });

  it('should encrypt and decrypt accessKeyId in a round-trip', () => {
    vi.spyOn(safeStorage, 'encrypt').mockImplementation((plaintext: string) => `enc-${plaintext}`);
    vi.spyOn(safeStorage, 'decrypt').mockImplementation((ciphertext: string) =>
      ciphertext.startsWith('enc-') ? ciphertext.slice(4) : ciphertext,
    );

    service.setSecretAccessKeyId('AKID123');
    const result = service.getSecretAccessKeyId();

    expect(result).toBe('AKID123');
  });
});
