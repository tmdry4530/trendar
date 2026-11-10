// client.ts — fetch 래퍼.
// 규약(CLAUDE.md §4): 응답 { ok, data } 를 언랩해 data 만 반환. ok===false 면 throw → 호출부 Toast.
// 기본값은 실제 백엔드(/api) 호출. VITE_USE_MOCK=true 면 인메모리 목으로 라우팅(백엔드 없이 데모용).
import { mockFetch } from './mock';
import i18n from '../i18n';

export const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true';

export type QueryValue = string | number | boolean | undefined | null;
export type QueryRecord = Record<string, QueryValue>;

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

const ERROR_MESSAGE_KEYS: Record<string, string> = {
  NETWORK_ERROR: 'errors.network',
  UNAUTHORIZED: 'errors.unauthorized',
  FORBIDDEN: 'errors.forbidden',
  NOT_FOUND: 'errors.notFound',
  VALIDATION_ERROR: 'errors.invalid',
  ETL_DAILY_LIMIT_EXCEEDED: 'errors.rateLimit',
  ETL_ALREADY_RUNNING: 'errors.collectionRunning',
  GITHUB_TOKEN_INVALID: 'errors.githubExpired',
  QUERY_LIMIT_EXCEEDED: 'errors.queryLimit',
  DUPLICATE: 'errors.duplicate',
  WEBHOOK_URL_INVALID: 'errors.webhookUrlInvalid',
  WEBHOOK_URL_BLOCKED: 'errors.webhookUrlBlocked',
  WEBHOOK_TEST_RATE_LIMITED: 'errors.webhookTestRateLimit',
};

function errorMessage(code: string, status: number): string {
  const key = ERROR_MESSAGE_KEYS[code]
    ?? (status === 401 ? 'errors.unauthorized' : status === 403 ? 'errors.forbidden' : null)
    ?? (status === 404 ? 'errors.notFound' : status === 400 ? 'errors.invalid' : 'errors.generic');
  return i18n.t(key);
}

/** API 오류는 서버의 내부 문구 대신 현재 화면 언어의 안전한 안내 문구로 바꾼다. */
export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) {
    super(errorMessage(code, status));
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

function buildQuery(query?: QueryRecord): string {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

interface RequestOptions {
  method?: string;
  query?: QueryRecord;
  body?: unknown;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', query, body } = opts;

  try {
    if (USE_MOCK) {
      return await mockFetch<T>(method, path, query, body);
    }

    const url = `/api${path}${buildQuery(query)}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError('NETWORK_ERROR', 0);
    }

    let payload: ApiEnvelope<T> | null = null;
    try {
      payload = (await res.json()) as ApiEnvelope<T>;
    } catch {
      payload = null;
    }

    if (!res.ok || !payload || payload.ok === false) {
      const code = payload?.error?.code ?? 'INTERNAL_ERROR';
      throw new ApiError(code, res.status);
    }

    return payload.data as T;
  } catch (err) {
    // 세션 만료 공통 처리: /auth/me 자체의 401(최초 인증 확인)은 제외하고,
    // 그 외 401은 AuthContext 가 구독해 즉시 anon 전환 + 로그인 화면으로 보낸다.
    if (err instanceof ApiError && err.status === 401 && path !== '/auth/me') {
      window.dispatchEvent(new Event('auth:unauthorized'));
    }
    throw err;
  }
}

export const api = {
  get: <T>(path: string, query?: QueryRecord) => request<T>(path, { method: 'GET', query }),
  post: <T>(path: string, body?: unknown, query?: QueryRecord) =>
    request<T>(path, { method: 'POST', body, query }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
