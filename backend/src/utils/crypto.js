// utils/crypto.js — OAuth 토큰 암복호화(AES-256-GCM) 및 세션 토큰 유틸
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

function getKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error('TOKEN_ENCRYPTION_KEY 환경변수가 설정되지 않았습니다.');
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY는 ${KEY_LENGTH * 2}자리 hex 문자열이어야 합니다 (32바이트).`
    );
  }
  return key;
}

export function encryptToken(plain) {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptToken(enc) {
  const key = getKey();
  const parts = String(enc).split(':');
  if (parts.length !== 3) {
    throw new Error('암호화된 토큰 형식이 올바르지 않습니다.');
  }
  const [ivB64, tagB64, cipherB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const encrypted = Buffer.from(cipherB64, 'base64');
  if (iv.length !== IV_LENGTH) {
    throw new Error('암호화된 토큰 형식이 올바르지 않습니다.');
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function newSessionToken() {
  const token = randomBytes(32).toString('hex');
  return { token, hash: hashSessionToken(token) };
}
