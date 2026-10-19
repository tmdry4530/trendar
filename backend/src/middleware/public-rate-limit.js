export function createRateLimiter({ limit, windowMs = 60000, now = Date.now, keyOf = (req) => req.ip, maxKeys = 10000 }) {
  const windows = new Map();

  function sweep(time) {
    for (const [key, entry] of windows) {
      if (entry.resetAt > time) break;
      windows.delete(key);
    }
  }

  return function rateLimit(req, res, next) {
    const time = now();
    sweep(time);
    const key = String(keyOf(req) ?? '');
    let entry = windows.get(key);
    if (!entry) {
      entry = { count: 0, resetAt: time + windowMs };
      windows.set(key, entry);
      while (windows.size > maxKeys) windows.delete(windows.keys().next().value);
    }
    entry.count += 1;
    if (entry.count <= limit) return next();
    res.status(429);
    res.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - time) / 1000))));
    res.set('Cache-Control', 'no-store');
    res.type('text/plain');
    res.send('Too Many Requests');
  };
}
