import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/middleware/public-rate-limit.js';

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    type(value) { this.headers['content-type'] = value; return this; },
    send(body) { this.body = body; return this; },
  };
}

function hit(limiter, ip) {
  const res = mockRes();
  let passed = false;
  limiter({ ip }, res, () => { passed = true; });
  return { passed, res };
}

test('rate limiter blocks over limit with 429 headers and resets after the window', () => {
  let clock = 1_000_000;
  const limiter = createRateLimiter({ limit: 3, now: () => clock });
  for (let i = 0; i < 3; i += 1) assert.equal(hit(limiter, '1.1.1.1').passed, true);
  const blocked = hit(limiter, '1.1.1.1');
  assert.equal(blocked.passed, false);
  assert.equal(blocked.res.statusCode, 429);
  assert.equal(blocked.res.headers['retry-after'], '60');
  assert.equal(blocked.res.headers['cache-control'], 'no-store');
  assert.equal(blocked.res.headers['content-type'], 'text/plain');
  assert.equal(hit(limiter, '2.2.2.2').passed, true);

  clock += 30_000;
  assert.equal(hit(limiter, '1.1.1.1').res.headers['retry-after'], '30');
  clock += 30_000;
  assert.equal(hit(limiter, '1.1.1.1').passed, true);
});

test('rate limiter evicts the oldest key beyond maxKeys', () => {
  const limiter = createRateLimiter({ limit: 1, now: () => 0, maxKeys: 2 });
  assert.equal(hit(limiter, 'a').passed, true);
  assert.equal(hit(limiter, 'b').passed, true);
  assert.equal(hit(limiter, 'b').passed, false);
  assert.equal(hit(limiter, 'c').passed, true);
  assert.equal(hit(limiter, 'a').passed, true);
  assert.equal(hit(limiter, 'c').passed, false);
});

test('rate limiter uses keyOf', () => {
  const limiter = createRateLimiter({ limit: 1, now: () => 0, keyOf: (req) => req.headers.key });
  const run = (key) => {
    let passed = false;
    limiter({ headers: { key } }, mockRes(), () => { passed = true; });
    return passed;
  };
  assert.equal(run('x'), true);
  assert.equal(run('x'), false);
  assert.equal(run('y'), true);
});
