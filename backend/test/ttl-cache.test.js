import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTtlCache } from '../src/utils/ttl-cache.js';

function fixture(maxEntries = 2) {
  let clock = 100;
  return { cache: createTtlCache({ ttlMs: 10, maxEntries, now: () => clock }), advance: (ms) => { clock += ms; } };
}

test('cache expires exactly at TTL and supports per-entry TTL', () => {
  const { cache, advance } = fixture();
  assert.equal(cache.get('missing'), undefined);
  assert.equal(cache.set('a', 1), 1);
  cache.set('b', 2, 20);
  advance(9);
  assert.equal(cache.get('a'), 1);
  advance(1);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  advance(10);
  assert.equal(cache.size(), 0);
});

test('cache evicts by insertion order, not read order, and resets order on replacement', () => {
  const { cache } = fixture();
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3);
  assert.equal(cache.get('a'), undefined);
  cache.set('b', 4);
  cache.set('d', 5);
  assert.equal(cache.get('c'), undefined);
  assert.equal(cache.get('b'), 4);
  assert.equal(cache.size(), 2);
});

test('simultaneous misses share the exact promise and run the loader once', async () => {
  const { cache } = fixture();
  let calls = 0;
  let resolve;
  const fn = () => { calls++; return new Promise((done) => { resolve = done; }); };
  const first = cache.getOrCompute('a', fn);
  const second = cache.getOrCompute('a', fn);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve({ result: 42 });
  assert.equal(await first, await second);
  assert.equal((await cache.getOrCompute('a', fn)).result, 42);
  assert.equal(calls, 1);
});

test('TTL begins at successful completion, then expired loaders recompute', async () => {
  const { cache, advance } = fixture();
  let finish;
  const value = cache.getOrCompute('a', () => new Promise((resolve) => { finish = resolve; }));
  await Promise.resolve();
  advance(30);
  finish(1);
  await value;
  advance(9);
  assert.equal(cache.get('a'), 1);
  advance(1);
  assert.equal(await cache.getOrCompute('a', () => 2), 2);
});

test('rejected promises and synchronous exceptions are not cached', async () => {
  const { cache } = fixture();
  let calls = 0;
  const failure = new Error('unavailable');
  const fn = () => { calls++; return Promise.reject(failure); };
  await assert.rejects(cache.getOrCompute('a', fn), (error) => error === failure);
  assert.equal(cache.size(), 0);
  await assert.rejects(cache.getOrCompute('a', fn), (error) => error === failure);
  assert.equal(calls, 2);
  await assert.rejects(cache.getOrCompute('b', () => { throw failure; }), (error) => error === failure);
  assert.equal(await cache.getOrCompute('b', () => 7), 7);
});

test('null and undefined values are cached and delete/clear remove values', async () => {
  const { cache } = fixture();
  let calls = 0;
  await cache.getOrCompute('null', () => { calls++; return null; });
  await cache.getOrCompute('undefined', () => { calls++; return undefined; });
  assert.equal(await cache.getOrCompute('null', () => 1), null);
  assert.equal(await cache.getOrCompute('undefined', () => 1), undefined);
  assert.equal(calls, 2);
  assert.equal(cache.delete('null'), true);
  assert.equal(cache.delete('missing'), false);
  cache.clear();
  assert.equal(cache.size(), 0);
});

test('cleared or deleted in-flight results do not repopulate the cache', async () => {
  for (const invalidate of [(cache) => cache.clear(), (cache) => cache.delete('a')]) {
    const { cache } = fixture();
    let finish;
    const first = cache.getOrCompute('a', () => new Promise((resolve) => { finish = resolve; }));
    await Promise.resolve();
    invalidate(cache);
    assert.equal(await cache.getOrCompute('a', () => 2), 2);
    finish(1);
    assert.equal(await first, 1);
    assert.equal(cache.get('a'), 2);
  }
});
