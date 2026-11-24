// @ts-check
import { parseAcceptLanguage, resolveLocale } from '../utils/locale.js';

const COUNTRY_CODE = /^[A-Z]{2}$/;
const INVALID_COUNTRY_CODES = new Set(['XX', 'T1']);

function readHeader(req, name) {
  if (typeof req?.get === 'function') return req.get(name);

  const headers = req?.headers;
  if (!headers || typeof headers !== 'object') return undefined;

  const headerName = Object.keys(headers).find(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
  return headerName ? headers[headerName] : undefined;
}

export function getCloudflareCountry(req) {
  // 표시 언어 힌트일 뿐 권한이나 지역 제한을 판단하는 데 사용하지 않는다.
  const headerValue = readHeader(req, 'cf-ipcountry');
  const countryCode = typeof headerValue === 'string'
    ? headerValue.trim().toUpperCase()
    : null;
  return countryCode
    && COUNTRY_CODE.test(countryCode)
    && !INVALID_COUNTRY_CODES.has(countryCode)
    ? countryCode
    : null;
}

export function createLocalizationController() {
  async function show(req, res) {
    const countryCode = getCloudflareCountry(req);
    const acceptedLanguages = parseAcceptLanguage(req.headers?.['accept-language']);
    const locale = resolveLocale({ countryCode, acceptedLanguages });
    res.set('Cache-Control', 'private, no-store');
    return res.json({ ok: true, data: { locale } });
  }

  return { show };
}

export const { show } = createLocalizationController();
