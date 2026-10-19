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

  function store(key, value, expiresAt) {
    entries.delete(key);
    entries.set(key, { value, expiresAt });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  function set(key, value, ttl = ttlMs) {
    store(key, value, now() + ttl);
    return value;
  }

  // fn은 { dependsOn(key) }를 받는다. 계산 중 읽은 다른 캐시 항목을 dependsOn으로 알리면
  // 결과는 min(완료 시각 + ttl, 그 항목들의 만료 시각)에 만료되어 원본 데이터보다 오래 남지 않는다.
  // 알린 항목이 이미 없거나 만료됐으면 결과를 캐시하지 않는다.
  function getOrCompute(key, fn, ttl = ttlMs) {
    const value = get(key);
    if (entries.has(key)) return Promise.resolve(value);
    if (pending.has(key)) return pending.get(key);
    let dependencyExpiresAt = Infinity;
    const context = {
      dependsOn(dependencyKey) {
        const entry = entries.get(dependencyKey);
        const expiresAt = entry && entry.expiresAt > now() ? entry.expiresAt : -Infinity;
        dependencyExpiresAt = Math.min(dependencyExpiresAt, expiresAt);
      },
    };
    const promise = Promise.resolve().then(() => fn(context)).then((result) => {
      if (pending.get(key) === promise) {
        pending.delete(key);
        const completedAt = now();
        const expiresAt = Math.min(completedAt + ttl, dependencyExpiresAt);
        if (expiresAt > completedAt) store(key, result, expiresAt);
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
