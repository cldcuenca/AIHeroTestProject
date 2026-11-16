export type StorageChange<T> = { value: T; next?: unknown };

// The callback is synchronous so validation and writes share the live IDB transaction.
// Controlled failure adapters exercise the collection interface, never this adapter directly.
export interface CollectionStorage {
  transact<T>(write: boolean, apply: (saved: unknown) => StorageChange<T>): Promise<T>;
}

export function indexedDbStorage(
  name: string,
  initialize: () => unknown,
): CollectionStorage {
  function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(name, 1);
      let blocked = false;
      request.onblocked = () => {
        blocked = true;
        reject(new Error('Storage upgrade blocked. Close other Taskroom tabs and retry.'));
      };
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = (event) => {
        if (blocked) {
          request.transaction?.abort();
          return;
        }
        if (event.oldVersion !== 0 || request.result.objectStoreNames.length !== 0) {
          request.transaction?.abort();
          return;
        }
        request.result.createObjectStore('state').add(initialize(), 'collection');
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        if (blocked) db.close();
        else resolve(db);
      };
    });
  }

  return {
    async transact<T>(write: boolean, apply: (saved: unknown) => StorageChange<T>): Promise<T> {
      const db = await open();
      return new Promise<T>((resolve, reject) => {
        let failure: unknown;
        let outcome: { value: T } | undefined;
        try {
          const transaction = db.transaction('state', write ? 'readwrite' : 'readonly');
          transaction.oncomplete = () => {
            db.close();
            if (outcome) resolve(outcome.value);
            else reject(new Error('Storage read did not return a collection.'));
          };
          transaction.onabort = () => {
            db.close();
            reject(failure ?? transaction.error ?? new Error('Storage transaction aborted.'));
          };
          const store = transaction.objectStore('state');
          const request = store.get('collection');
          request.onsuccess = () => {
            try {
              const saved: unknown = request.result;
              const change = apply(saved);
              outcome = { value: change.value };
              if (change.next !== undefined) {
                if (!write) throw new Error('Cannot write in a read transaction.');
                store.put(change.next, 'collection');
              }
            } catch (error) {
              failure = error;
              transaction.abort();
            }
          };
        } catch (error) {
          db.close();
          reject(error);
        }
      });
    },
  };
}
