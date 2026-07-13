// test/crypto.test.js — utils/crypto 라운드트립 및 실패 케이스 검증
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptToken, decryptToken, hashSessionToken, newSessionToken } from '../src/utils/crypto.js';

const VALID_KEY = randomBytes(32).toString('hex');
const ORIGINAL_KEY = process.env.TOKEN_ENCRYPTION_KEY;

after(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  } else {
    process.env.TOKEN_ENCRYPTION_KEY = ORIGINAL_KEY;
  }
});

test('encryptToken/decryptToken round-trip', () => {
  process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY;
  const plain = 'gho_super-secret-token-value';
  const enc = encryptToken(plain);
  assert.equal(enc.split(':').length, 3);
  assert.equal(decryptToken(enc), plain);
});

test('decryptToken throws when ciphertext is tampered', () => {
  process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY;
  const enc = encryptToken('another-secret');
  const [iv, tag, cipher] = enc.split(':');
  const tamperedCipher = Buffer.from(cipher, 'base64');
  tamperedCipher[0] ^= 0xff;
  const tampered = `${iv}:${tag}:${tamperedCipher.toString('base64')}`;
  assert.throws(() => decryptToken(tampered));
});

test('decryptToken throws when auth tag is tampered', () => {
  process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY;
  const enc = encryptToken('yet-another-secret');
  const [iv, tag, cipher] = enc.split(':');
  const tamperedTag = Buffer.from(tag, 'base64');
  tamperedTag[0] ^= 0xff;
  const tampered = `${iv}:${tamperedTag.toString('base64')}:${cipher}`;
  assert.throws(() => decryptToken(tampered));
});

test('encryptToken throws when TOKEN_ENCRYPTION_KEY is missing', () => {
  delete process.env.TOKEN_ENCRYPTION_KEY;
  assert.throws(() => encryptToken('x'));
});

test('encryptToken throws when TOKEN_ENCRYPTION_KEY has wrong length', () => {
  process.env.TOKEN_ENCRYPTION_KEY = 'deadbeef';
  assert.throws(() => encryptToken('x'));
});

test('hashSessionToken is deterministic', () => {
  const token = 'fixed-token-value';
  assert.equal(hashSessionToken(token), hashSessionToken(token));
});

test('newSessionToken returns matching hex token/hash and is unique per call', () => {
  const a = newSessionToken();
  const b = newSessionToken();
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(hashSessionToken(a.token), a.hash);
  assert.notEqual(a.token, b.token);
});
