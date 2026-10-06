// Open House kiosk — on-device storage (IndexedDB).
// Two stores: 'kv' (settings, RSVP list) and 'checkins' (one record per check-in, keyed by id).
// Every write resolves only when its transaction has completed, i.e. the data is committed.
//
// Resilience: WebKit can drop an IndexedDB connection after the app has been suspended (e.g. overnight)
// or stall a request. A dropped connection is reopened, every transaction has a timeout, and a write that
// fails because the connection died is retried once on a fresh connection (puts are idempotent by key).

const DB_NAME = 'oh-kiosk';
const DB_VERSION = 1;
const TX_TIMEOUT_MS = 8000;
let dbPromise = null;

function openOnce(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('IndexedDB open timed out')), timeoutMs);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('checkins')) db.createObjectStore('checkins', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      const db = req.result;
      db.onclose = () => { dbPromise = null; };                          // WebKit dropped the connection
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { clearTimeout(timer); reject(req.error); };
    req.onblocked = () => { clearTimeout(timer); reject(new Error('IndexedDB open blocked')); };
  });
}

export function openDb() {
  // Some WebKit versions occasionally stall the first open; retry once before giving up.
  dbPromise ??= openOnce(4000).catch(() => openOnce(8000)).catch(err => { dbPromise = null; throw err; });
  return dbPromise;
}

const DEAD_CONNECTION = new Set(['InvalidStateError', 'UnknownError', 'TimeoutError']);

function runOnce(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    let t, out, settled = false;
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ok ? resolve(value) : reject(value);
    };
    const timer = setTimeout(() => {
      try { t?.abort(); } catch {}
      const err = new Error('IndexedDB transaction timed out');
      err.name = 'TimeoutError';
      finish(false, err);
    }, TX_TIMEOUT_MS);
    try {
      try { t = db.transaction(stores, mode, { durability: 'strict' }); }
      catch (err) { if (err?.name === 'InvalidStateError') throw err; t = db.transaction(stores, mode); }
    } catch (err) { finish(false, err); return; }
    t.oncomplete = () => finish(true, out instanceof IDBRequest ? out.result : out);
    // a failed request reports here before the transaction's own error is set: never settle with null
    t.onerror = e => finish(false, t.error || e.target?.error || new Error('IndexedDB request failed'));
    t.onabort = () => finish(false, t.error || new Error('Transaction aborted'));
    try { out = fn(t); } catch (err) { try { t.abort(); } catch {} finish(false, err); }
  });
}

/** Run fn(transaction); resolve once the transaction commits. Retries once on a fresh connection if the old one died. */
async function run(stores, mode, fn) {
  const p = openDb();
  const db = await p;
  try {
    return await runOnce(db, stores, mode, fn);
  } catch (err) {
    if (!DEAD_CONNECTION.has(err?.name)) throw err;
    try { db.close(); } catch {}
    if (dbPromise === p) dbPromise = null;
    return runOnce(await openDb(), stores, mode, fn);
  }
}

export const kvGet = key => run(['kv'], 'readonly', t => t.objectStore('kv').get(key));
export const kvPut = (key, value) => run(['kv'], 'readwrite', t => { t.objectStore('kv').put(value, key); });
export const putCheckin = rec => run(['checkins'], 'readwrite', t => { t.objectStore('checkins').put(rec); });
export const getAllCheckins = () => run(['checkins'], 'readonly', t => t.objectStore('checkins').getAll());
export const deleteCheckins = ids => run(['checkins'], 'readwrite', t => {
  const s = t.objectStore('checkins');
  ids.forEach(id => s.delete(id));
});
export const clearEverything = () => run(['kv', 'checkins'], 'readwrite', t => {
  t.objectStore('kv').clear();
  t.objectStore('checkins').clear();
});

/** Cheap read used when the app comes back to the foreground, so a dead connection is replaced before a guest taps. */
export const ping = () => kvGet('settings').then(() => true, () => false);

/** Ask the browser to exempt this app's storage from automatic eviction. Returns true/false/null (unsupported). */
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return false; }
}

export async function isPersisted() {
  try { return navigator.storage?.persisted ? await navigator.storage.persisted() : null; }
  catch { return null; }
}
