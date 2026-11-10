// 사용자가 등록한 수신 URL의 형식과 주소를 검증한다. 서버가 이 주소로 요청을 보내므로
// 내부망으로 향하는 주소를 여기 한 곳에서 걸러낸다.
import dns from 'node:dns';
import net from 'node:net';

export const MAX_URL_LENGTH = 2048;

export class TargetError extends Error {
  /** @param {'WEBHOOK_URL_INVALID' | 'WEBHOOK_URL_BLOCKED'} code */
  constructor(code) {
    super(code);
    this.name = 'TargetError';
    this.code = code;
  }
}

// 운영 환경에서는 값과 무관하게 허용하지 않는다(D-012).
export function allowPrivateTargets(env = process.env) {
  return env.NODE_ENV !== 'production' && env.WEBHOOK_ALLOW_PRIVATE_TARGETS === 'true';
}

const LOOKUP_TIMEOUT_MS = 3000;

const blocked = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(prefix, bits, 'ipv4');
// ::/96(IPv4 호환, ::와 ::1 포함)과 ::ffff:0:0:0/96(IPv4 변환)은 쓰이지 않는 예약 대역이라 통째로 막는다.
for (const [prefix, bits] of [
  ['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b:1::', 48], ['100::', 64], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10],
  ['ff00::', 8], ['2001:db8::', 32], ['2001::', 32],
]) blocked.addSubnet(prefix, bits, 'ipv6');

// IPv4를 품은 IPv6 주소: IPv4 매핑(::ffff:0:0/96), NAT64(64:ff9b::/96), 6to4(2002::/16).
const embedsIpv4 = new net.BlockList();
embedsIpv4.addSubnet('::ffff:0:0', 96, 'ipv6');
embedsIpv4.addSubnet('64:ff9b::', 96, 'ipv6');
const sixToFour = new net.BlockList();
sixToFour.addSubnet('2002::', 16, 'ipv6');

function ipv6Groups(address) {
  let text = address.split('%')[0];
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : new Array(Math.max(0, 8 - left.length - right.length)).fill('0');
  return [...left, ...fill, ...right].map((group) => parseInt(group, 16));
}

function ipv4From(high, low) {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family !== 6) return true;
  if (blocked.check(address, 'ipv6')) return true;
  const groups = ipv6Groups(address);
  if (embedsIpv4.check(address, 'ipv6')) return blocked.check(ipv4From(groups[6], groups[7]), 'ipv4');
  if (sixToFour.check(address, 'ipv6')) return blocked.check(ipv4From(groups[1], groups[2]), 'ipv4');
  return false;
}

/**
 * @param {unknown} raw
 * @param {{ allowPrivate?: boolean }} [options]
 * @returns {URL}
 */
export function parseTargetUrl(raw, { allowPrivate = false } = {}) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) throw new TargetError('WEBHOOK_URL_INVALID');
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new TargetError('WEBHOOK_URL_INVALID');
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new TargetError('WEBHOOK_URL_INVALID');
  if (url.username || url.password || !url.hostname) throw new TargetError('WEBHOOK_URL_INVALID');
  url.hash = '';
  return url;
}

function hostOf(url) {
  return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}

/**
 * 연결할 주소를 정한다. 이름이 여러 주소로 풀리면 하나라도 차단 대역이면 거부한다.
 * @param {URL} url
 * @param {{ allowPrivate?: boolean, lookup?: (host: string, options: object) => Promise<Array<{ address: string, family: number }>> }} [options]
 * @returns {Promise<{ address: string, family: 4 | 6 }>}
 */
export async function resolveTarget(url, { allowPrivate = false, lookup = dns.promises.lookup } = {}) {
  const host = hostOf(url);
  let addresses;
  const literal = net.isIP(host);
  if (literal) {
    addresses = [{ address: host, family: literal }];
  } else {
    // getaddrinfo에는 시간 제한이 없어, 응답하지 않는 DNS가 요청과 발신 처리를 붙잡지 않게 끊는다.
    let timer;
    try {
      addresses = await Promise.race([
        lookup(host, { all: true, verbatim: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS_TIMEOUT')), LOOKUP_TIMEOUT_MS); }),
      ]);
    } catch {
      throw new TargetError('WEBHOOK_URL_INVALID');
    } finally {
      clearTimeout(timer);
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) throw new TargetError('WEBHOOK_URL_INVALID');
  if (!allowPrivate && addresses.some(({ address }) => isBlockedAddress(address))) throw new TargetError('WEBHOOK_URL_BLOCKED');
  const { address, family } = addresses[0];
  return { address, family: family === 6 ? 6 : 4 };
}

/** @returns {'generic' | 'discord' | 'slack'} */
export function formatOf(url) {
  const host = url.hostname.toLowerCase();
  if ((host === 'discord.com' || host === 'discordapp.com') && url.pathname.startsWith('/api/webhooks/')) return 'discord';
  if (host === 'hooks.slack.com') return 'slack';
  return 'generic';
}

// 화면에 보여 줄 가린 주소. Discord·Slack 주소는 경로가 곧 비밀이라 호스트와 끝 4자만 남긴다. 짧은 경로는 전부 가린다.
export function maskUrl(url) {
  const rest = `${url.pathname}${url.search}`;
  const tail = rest === '/' ? '' : rest.length > 5 ? `…${rest.slice(-4)}` : '…';
  return `${url.protocol}//${url.host}/${tail}`.slice(0, 300);
}
