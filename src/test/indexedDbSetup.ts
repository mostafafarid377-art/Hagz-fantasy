// Each jsdom test receives an isolated, in-memory IndexedDB. Production code
// must still fail closed if real browser storage is unavailable.
import { beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
beforeEach(() => { Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() }); });
