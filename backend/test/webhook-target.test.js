import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TargetError, allowPrivateTargets, formatOf, isBlockedAddress, maskUrl, parseTargetUrl, resolveTarget,
} from '../src/utils/webhook-target.js';

const lookupOf = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const codeOf = async (run) => {
  try {
    await run();
    return null;
  } catch (error) {
    assert.ok(error instanceof TargetError, String(error));
    return error.code;
  }
};

test('사설·루프백·링크로컬·예약 대역과 IPv4를 품은 IPv6 주소를 차단하고 공개 주소는 통과시킨다', () => {
  for (const address of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.5',
    '192.168.1.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2001::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '64:ff9b::169.254.169.254', '2002:7f00:1::1', '2002:c0a8:101::1',
    // 예약 대역: IPv4 호환·IPv4 변환·로컬용 NAT64·site-local·discard, 6to4 중계
    '::127.0.0.1', '::8.8.8.8', '::ffff:0:127.0.0.1', '64:ff9b:1::7f00:1', 'fec0::1', '100::1', '192.88.99.1',
    'not-an-ip', '',
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1']) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test('https가 아니거나 사용자 정보가 있거나 너무 길거나 URL이 아니면 거부한다', async () => {
  for (const raw of [
    'http://example.com/hook', 'ftp://example.com/hook', 'https://user:pass@example.com/hook', 'https://user@example.com/hook',
    'not a url', '', `https://example.com/${'a'.repeat(2048)}`, null, 42, 'javascript:alert(1)', 'file:///etc/passwd',
  ]) {
    assert.equal(await codeOf(() => parseTargetUrl(raw)), 'WEBHOOK_URL_INVALID', String(raw).slice(0, 40));
  }
  const url = parseTargetUrl(' https://example.com:8443/hook?x=1#frag ');
  assert.equal(url.href, 'https://example.com:8443/hook?x=1');
});

test('IP 리터럴 호스트는 표기법과 무관하게 검사한다', async () => {
  for (const raw of [
    'https://127.0.0.1/hook', 'https://2130706433/hook', 'https://0x7f.0.0.1/hook', 'https://[::1]/hook', 'https://[::ffff:10.0.0.1]/hook',
    'https://169.254.169.254/latest/meta-data', 'https://192.168.0.10:8443/hook',
  ]) {
    assert.equal(await codeOf(() => resolveTarget(parseTargetUrl(raw), { lookup: lookupOf('8.8.8.8') })), 'WEBHOOK_URL_BLOCKED', raw);
  }
  assert.deepEqual(await resolveTarget(parseTargetUrl('https://8.8.8.8/hook')), { address: '8.8.8.8', family: 4 });
});

test('이름이 풀린 주소 중 하나라도 차단 대역이면 거부하고, 풀리지 않으면 잘못된 URL이다', async () => {
  const url = parseTargetUrl('https://hooks.example.com/in');
  assert.deepEqual(await resolveTarget(url, { lookup: lookupOf('93.184.216.34', '2606:2800:220:1::1') }), { address: '93.184.216.34', family: 4 });
  assert.deepEqual(await resolveTarget(url, { lookup: lookupOf('2606:2800:220:1::1') }), { address: '2606:2800:220:1::1', family: 6 });
  assert.equal(await codeOf(() => resolveTarget(url, { lookup: lookupOf('93.184.216.34', '10.0.0.5') })), 'WEBHOOK_URL_BLOCKED');
  assert.equal(await codeOf(() => resolveTarget(url, { lookup: lookupOf('127.0.0.1') })), 'WEBHOOK_URL_BLOCKED');
  assert.equal(await codeOf(() => resolveTarget(url, { lookup: lookupOf() })), 'WEBHOOK_URL_INVALID');
  assert.equal(await codeOf(() => resolveTarget(url, { lookup: async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); } })), 'WEBHOOK_URL_INVALID');
});

test('비공개 주소 허용은 운영이 아닌 환경에서 값이 true일 때만 켜지고, 켜지면 http와 사설 주소를 받는다', async () => {
  assert.equal(allowPrivateTargets({ WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true' }), true);
  assert.equal(allowPrivateTargets({ WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true', NODE_ENV: 'production' }), false);
  assert.equal(allowPrivateTargets({ WEBHOOK_ALLOW_PRIVATE_TARGETS: '1' }), false);
  assert.equal(allowPrivateTargets({}), false);
  const url = parseTargetUrl('http://127.0.0.1:9000/hook', { allowPrivate: true });
  assert.deepEqual(await resolveTarget(url, { allowPrivate: true }), { address: '127.0.0.1', family: 4 });
});

test('Discord·Slack 주소를 형식으로 구분하고, 화면용 주소는 호스트와 끝 4자만 남긴다', () => {
  assert.equal(formatOf(new URL('https://discord.com/api/webhooks/123/abcDEF')), 'discord');
  assert.equal(formatOf(new URL('https://discordapp.com/api/webhooks/123/abcDEF')), 'discord');
  assert.equal(formatOf(new URL('https://discord.com/other')), 'generic');
  assert.equal(formatOf(new URL('https://hooks.slack.com/services/T0/B0/xyz')), 'slack');
  assert.equal(formatOf(new URL('https://example.com/hook')), 'generic');
  assert.equal(maskUrl(new URL('https://discord.com/api/webhooks/1234567890/secretTOKENvalue')), 'https://discord.com/…alue');
  assert.equal(maskUrl(new URL('https://example.com:8443/hook?key=abcdef')), 'https://example.com:8443/…cdef');
  assert.equal(maskUrl(new URL('https://example.com/')), 'https://example.com/');
  // 짧은 경로는 끝 4자가 곧 전체라서 전부 가린다.
  assert.equal(maskUrl(new URL('https://example.com/abcd')), 'https://example.com/…');
  assert.doesNotMatch(maskUrl(new URL('https://hooks.slack.com/services/T0/B0/verysecretpath')), /verysecret/);
});
