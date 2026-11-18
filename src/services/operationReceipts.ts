import { rpc } from './api';
import { getSupabase } from '../lib/supabase';

export type ReceiptState = 'unknown' | 'pending' | 'cancelled' | 'committed';
export type Receipt = { state: ReceiptState; result?: unknown };
export type PendingOperation = {
  actorId: string; scope: string; kind: string; operationId: string;
  payload: Record<string, unknown>; createdAt: string; recoveryState: 'unresolved';
};
export type ReceiptTransport = {
  register: (op: PendingOperation) => Promise<Receipt>;
  execute: (op: PendingOperation) => Promise<Receipt>;
  status: (op: PendingOperation) => Promise<Receipt>;
  cancel: (op: PendingOperation) => Promise<Receipt>;
};

/** Each RPC is bound to the intended actor at the database, even if auth switches. */
export const liveReceiptTransport: ReceiptTransport = {
  register: (op) => invoke(op, 'register'),
  execute: (op) => invoke(op, 'execute'),
  status: (op) => invoke(op, 'status'),
  cancel: (op) => invoke(op, 'cancel'),
};
async function invoke(op: PendingOperation, action: string): Promise<Receipt> {
  const client = getSupabase();
  if (!client) throw new Error('Authentication unavailable');
  const { data, error } = await client.auth.getSession();
  if (error || data.session?.user.id !== op.actorId) throw new Error('Account changed or signed out');
  const value = await rpc<Receipt>('ff_operation_for_actor', {
    p_actor: op.actorId, p_action: action, p_operation: op.operationId,
    p_kind: action === 'register' ? op.kind : null, p_payload: action === 'register' ? op.payload : null,
  });
  if (!value || !['unknown', 'pending', 'cancelled', 'committed'].includes(value.state)
      || (action !== 'register' && value.state === 'committed' && (value.result === undefined || value.result === null))) {
    throw new Error('Invalid operation receipt');
  }
  return value;
}

const DB = 'ff-operation-receipts-v1';
const STORE = 'pending';
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    let blocked = false;
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE, { keyPath: ['actorId', 'scope'] }); };
    request.onerror = () => reject(request.error ?? new Error('Operation storage unavailable'));
    request.onblocked = () => { blocked = true; reject(new Error('Operation storage is blocked')); };
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
  });
}
function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    let value: T;
    request.onsuccess = () => { value = request.result; };
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Operation storage failed')); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Operation storage failed')); };
  }));
}
function uuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Fail closed for unsupported values; clone once before durable reservation. */
function immutablePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(payload, (_key, value) => {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint'
        || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Invalid operation payload');
    return value;
  });
  if (!json || new TextEncoder().encode(json).length > 16384) throw new Error('Invalid operation payload');
  const clone = JSON.parse(json);
  if (!clone || Array.isArray(clone) || typeof clone !== 'object') throw new Error('Invalid operation payload');
  return clone;
}

/** A unique IndexedDB key atomically rejects competing same-origin intents. */
export async function reserveOperation(actorId: string, scope: string, kind: string, payload: Record<string, unknown>): Promise<PendingOperation> {
  if (!actorId || !scope || !kind) throw new Error('Operation identity and scope are required');
  const op: PendingOperation = { actorId, scope, kind, operationId: uuid(), payload: immutablePayload(payload),
    createdAt: new Date().toISOString(), recoveryState: 'unresolved' };
  await transaction('readwrite', (store) => store.add(op));
  return op;
}
export async function readOperation(actorId: string, scope: string): Promise<PendingOperation | undefined> {
  return transaction('readonly', (store) => store.get([actorId, scope]));
}

/** Delete only the exact resolved operation; never delete a replacement lease. */
export async function clearOperation(op: PendingOperation, receipt: Receipt): Promise<void> {
  if (receipt.state !== 'committed' && receipt.state !== 'cancelled') throw new Error('Operation remains unresolved');
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite'); const store = tx.objectStore(STORE);
    const get = store.get([op.actorId, op.scope]);
    get.onsuccess = () => { if ((get.result as PendingOperation | undefined)?.operationId === op.operationId) store.delete([op.actorId, op.scope]); };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Operation storage failed')); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Operation storage failed')); };
  });
}
function check(active: () => boolean) { if (!active()) throw new Error('Account changed'); }
/** Explicit user retry only; always load the immutable envelope from durable storage. */
export async function submitOperation(op: PendingOperation, transport: ReceiptTransport, active: () => boolean): Promise<Receipt> {
  check(active);
  const saved = await readOperation(op.actorId, op.scope);
  check(active);
  if (!saved || saved.operationId !== op.operationId || !saved.payload || !saved.createdAt || saved.recoveryState !== 'unresolved') {
    throw new Error('Operation envelope unavailable; reconciliation required');
  }
  const registered = await transport.register(saved);
  check(active);
  if (registered.state === 'committed') return inspectOperation(saved, transport, active);
  if (registered.state !== 'pending') return registered;
  const result = await transport.execute(saved);
  check(active);
  return result;
}
export async function inspectOperation(op: PendingOperation, transport: ReceiptTransport, active: () => boolean): Promise<Receipt> {
  check(active); const result = await transport.status(op); check(active); return result;
}
export async function cancelOperation(op: PendingOperation, transport: ReceiptTransport, active: () => boolean): Promise<Receipt> {
  check(active); const result = await transport.cancel(op); check(active); return result;
}
