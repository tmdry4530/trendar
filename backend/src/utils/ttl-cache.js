export function createTtlCache({ ttlMs, maxEntries = 500, now = Date.now }) {
  const entries = new Map();
  const pending = new Map();

  function get(key) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function set(key, value, ttl = ttlMs) {
    entries.delete(key);
    entries.set(key, { value, expiresAt: now() + ttl });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return value;
  }

  function getOrCompute(key, fn, ttl = ttlMs) {
    const value = get(key);
    if (entries.has(key)) return Promise.resolve(value);
    if (pending.has(key)) return pending.get(key);
    const promise = Promise.resolve().then(fn).then((result) => {
      if (pending.get(key) === promise) {
        pending.delete(key);
        set(key, result, ttl);
      }
      return result;
    }, (error) => {
      if (pending.get(key) === promise) pending.delete(key);
      throw error;
    });
    pending.set(key, promise);
    return promise;
  }

  return {
    get,
    set,
    getOrCompute,
    delete(key) {
      pending.delete(key);
      return entries.delete(key);
    },
    clear() {
      entries.clear();
      pending.clear();
    },
    size() {
      for (const key of entries.keys()) get(key);
      return entries.size;
    },
  };
}
