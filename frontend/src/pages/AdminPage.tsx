// AdminPage.tsx — 소유자 전용 운영 현황(조회 전용). 운영 화면은 한국어 고정(lang="ko").
// 인가는 서버가 한다. isAdmin 은 화면 진입 안내용이며, 서버가 403 을 주면 이전 데이터 없이 권한 안내로 전환한다.
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { fetchAdminFeeds, fetchAdminOverview, fetchAdminUsers } from '../api/admin';
import { formatInt } from '../lib/format';
import type { AdminFeedsResult, AdminOverview, AdminUser, AdminUsersResult } from '../types';
import styles from './AdminPage.module.css';

const LOCALE = 'ko-KR';
const TIME_ZONE = 'Asia/Seoul';
const PAGE_SIZE_FALLBACK = 25;

// ── 포맷 ─────────────────────────────────────────────────────────────────────

// 모든 시각은 한국 표준시(KST). 셀에는 짧은 형식만 쓰고 시간대는 표 caption 에 한 번만 밝힌다.
const dateTimeParts = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parts(d: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of dateTimeParts.formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** "2026.11.05 15:04" */
function fmtShortDateTime(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return '—';
  const p = parts(d);
  return `${p.year}.${p.month}.${p.day} ${p.hour}:${p.minute}`;
}

/** "2026.11.05" */
function fmtShortDate(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return '—';
  const p = parts(d);
  return `${p.year}.${p.month}.${p.day}`;
}

/** 조회 시각 표기용: "2026.11.05 15:04 KST" */
function fmtStamp(iso: string | null | undefined): string {
  const t = fmtShortDateTime(iso);
  return t === '—' ? t : `${t} KST`;
}

const people = (n: number) => `${formatInt(n, LOCALE)}명`;

// ── 상태 표기 ────────────────────────────────────────────────────────────────

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

const SUBSCRIPTION_LABEL: Record<string, string> = {
  active: '이용 중',
  trialing: '체험 중',
  past_due: '결제 지연',
  canceled: '해지됨',
  paused: '일시 중지',
  none: '구독 없음',
};
const SUBSCRIPTION_TONE: Record<string, Tone> = {
  active: 'ok',
  trialing: 'ok',
  past_due: 'warn',
  canceled: 'neutral',
  paused: 'neutral',
  none: 'neutral',
};
const UNKNOWN_SUBSCRIPTION = '기타 상태';

/** 알려진 코드만 한국어로 바꾸고, 그 외 원문 코드는 화면에 내보내지 않는다. */
function subscriptionLabel(status: string | null): string {
  if (status == null) return SUBSCRIPTION_LABEL.none;
  return Object.prototype.hasOwnProperty.call(SUBSCRIPTION_LABEL, status) ? SUBSCRIPTION_LABEL[status] : UNKNOWN_SUBSCRIPTION;
}
function subscriptionTone(status: string | null): Tone {
  if (status == null) return 'neutral';
  return Object.prototype.hasOwnProperty.call(SUBSCRIPTION_TONE, status) ? SUBSCRIPTION_TONE[status] : 'neutral';
}

/** 서버 구독 분포를 화면 라벨 단위로 합산한다(알 수 없는 코드는 '기타 상태' 하나로). */
function groupSubscriptions(rows: AdminOverview['subscriptions']): { label: string; tone: Tone; count: number }[] {
  const merged = new Map<string, { label: string; tone: Tone; count: number }>();
  for (const row of rows) {
    const label = subscriptionLabel(row.status);
    const hit = merged.get(label);
    if (hit) hit.count += row.count;
    else merged.set(label, { label, tone: subscriptionTone(row.status), count: row.count });
  }
  return [...merged.values()].sort((a, b) => b.count - a.count);
}

const ETL_LABEL: Record<string, { label: string; tone: Tone }> = {
  ok: { label: '성공', tone: 'ok' },
  error: { label: '오류', tone: 'danger' },
  token_invalid: { label: '토큰 무효', tone: 'danger' },
};

function Badge({ tone, children }: { tone: Tone; children: string }) {
  return <span className={`${styles.badge} ${styles[`tone_${tone}`]}`}>{children}</span>;
}

// ── 조회 훅 ──────────────────────────────────────────────────────────────────
// 요청마다 상태를 loading 으로 되돌리므로 이전 응답·이전 페이지 데이터가 화면에 남지 않는다.
// 의존 값이 바뀌면 cleanup 이 이전 응답을 무시한다.

type Resource<T> =
  | { status: 'loading' }
  | { status: 'error'; httpStatus: number }
  | { status: 'ok'; data: T };

function useAdminResource<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  refreshKey: number,
  onForbidden: () => void,
): { resource: Resource<T>; retry: () => void } {
  const [resource, setResource] = useState<Resource<T>>({ status: 'loading' });
  const [retryTick, setRetryTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const memoFetcher = useCallback(fetcher, deps);

  useEffect(() => {
    let cancelled = false;
    setResource({ status: 'loading' });
    memoFetcher().then(
      (data) => {
        if (!cancelled) setResource({ status: 'ok', data });
      },
      (err: unknown) => {
        if (cancelled) return;
        const httpStatus = err instanceof ApiError ? err.status : 0;
        setResource({ status: 'error', httpStatus });
        if (httpStatus === 403) onForbidden();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [memoFetcher, refreshKey, retryTick, onForbidden]);

  const retry = useCallback(() => setRetryTick((t) => t + 1), []);
  return { resource, retry };
}

function errorText(httpStatus: number): string {
  if (httpStatus === 0) return '서버에 연결하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.';
  if (httpStatus === 400) return '조회 조건이 올바르지 않습니다. 검색어를 바꾸거나 1페이지부터 다시 조회해 주세요.';
  return '운영 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

// ── 공통 상태 ────────────────────────────────────────────────────────────────

function Loading({ label }: { label: string }) {
  return (
    <div className={styles.state} role="status">
      <span className="spinner" aria-hidden />
      <span className={styles.stateText}>{label}</span>
    </div>
  );
}

function Failure({ httpStatus, onRetry }: { httpStatus: number; onRetry: () => void }) {
  return (
    <div className={`${styles.state} ${styles.stateError}`} role="alert">
      <div className={styles.stateTitle}>불러오지 못했습니다</div>
      <p className={styles.stateText}>{errorText(httpStatus)}</p>
      <button type="button" className={`btn ${styles.touch}`} onClick={onRetry}>
        다시 시도
      </button>
    </div>
  );
}

function AccessDenied() {
  return (
    <div className={`page ${styles.root}`} lang="ko">
      <div className={`panel ${styles.denied}`} role="alert">
        <div className={styles.deniedIcon} aria-hidden>
          ⊘
        </div>
        <h1 className={styles.deniedTitle}>접근 권한이 없습니다</h1>
        <p className={styles.stateText}>
          이 화면은 서비스 소유자 계정으로 로그인했을 때만 볼 수 있습니다. 현재 계정에는 운영 현황을 조회할 권한이 없습니다.
        </p>
        <Link to="/" className={`btn ${styles.touch}`}>
          대시보드로 돌아가기
        </Link>
      </div>
    </div>
  );
}

// ── 요약 ─────────────────────────────────────────────────────────────────────

function SummaryCard({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'neutral' | 'accent' | 'danger';
}) {
  const toneClass = tone === 'danger' ? styles.cardDanger : tone === 'accent' ? styles.cardAccent : '';
  return (
    <div className={`${styles.card} ${toneClass}`}>
      <div className={styles.cardLabel}>{label}</div>
      <div className={styles.cardValue}>{value}</div>
      <div className={styles.cardHint}>{hint}</div>
    </div>
  );
}

function DistRow({ label, count, total, tone }: { label: string; count: number; total: number; tone: Tone }) {
  const pct = total > 0 ? Math.min(100, (count / total) * 100) : 0;
  return (
    <li className={styles.distRow}>
      <span className={styles.distLabel}>{label}</span>
      <span className={styles.distCount}>{people(count)}</span>
      <span className={styles.distBar} aria-hidden>
        <span className={`${styles.distFill} ${styles[`fill_${tone}`]}`} style={{ width: `${pct}%` }} />
      </span>
    </li>
  );
}

function Overview({ overview }: { overview: AdminOverview }) {
  const { users } = overview;
  const subs = groupSubscriptions(overview.subscriptions);
  return (
    <>
      <div className={styles.cards}>
        <SummaryCard label="전체 회원" value={people(users.total)} hint="구독 여부와 관계없이 가입한 모든 회원" />
        <SummaryCard
          label="저장 Pro 플랜"
          value={people(users.pro)}
          hint={`저장된 플랜 값 기준 · Free ${people(users.free)}. 결제·매출이 아닙니다`}
          tone="accent"
        />
        <SummaryCard
          label="수집 실패"
          value={people(users.etl_failed)}
          hint={`최근 수집이 오류·토큰 무효로 끝난 회원 · 토큰 무효 표시 ${people(users.token_invalid)}`}
          tone={users.etl_failed > 0 ? 'danger' : 'neutral'}
        />
        <SummaryCard
          label="공개 레포"
          value={`${formatInt(overview.public_repos, LOCALE)}개`}
          hint="공개 레포 테이블에 저장된 전체 행 수 · 현재 피드 노출 수와 다릅니다"
        />
      </div>

      <div className={styles.dists}>
        <section className="panel" aria-labelledby="admin-plan-title">
          <div className="panel__head">
            <h2 id="admin-plan-title" className="panel__title">
              저장 플랜
            </h2>
            <span className={styles.panelNote}>users.plan 저장값</span>
          </div>
          <ul className={styles.distList}>
            <DistRow label="Free" count={users.free} total={users.total} tone="neutral" />
            <DistRow label="Pro" count={users.pro} total={users.total} tone="ok" />
          </ul>
        </section>

        <section className="panel" aria-labelledby="admin-sub-title">
          <div className="panel__head">
            <h2 id="admin-sub-title" className="panel__title">
              구독 상태 분포
            </h2>
            <span className={styles.panelNote}>플랜과 별개</span>
          </div>
          {subs.length === 0 ? (
            <p className={styles.stateText}>집계할 회원이 없습니다.</p>
          ) : (
            <ul className={`${styles.distList} ${styles.distListWide}`}>
              {subs.map((s) => (
                <DistRow key={s.label} label={s.label} count={s.count} total={users.total} tone={s.tone} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

// ── 회원 목록 ────────────────────────────────────────────────────────────────

function UserRow({ user }: { user: AdminUser }) {
  const etl = user.last_etl_status ? ETL_LABEL[user.last_etl_status] : undefined;
  return (
    <tr>
      <td data-label="회원">
        <div className={styles.cellUser}>
          <span className={styles.login} title={user.login}>{user.login}</span>
          <span className={styles.name} title={user.name || undefined}>
            {user.name || '이름 없음'}
          </span>
        </div>
      </td>
      <td data-label="가입" className={styles.nowrap}>
        {fmtShortDateTime(user.created_at)}
      </td>
      <td data-label="저장 플랜">
        <Badge tone={user.plan === 'pro' ? 'ok' : 'neutral'}>{user.plan === 'pro' ? 'Pro' : 'Free'}</Badge>
      </td>
      <td data-label="구독">
        <div className={styles.stack}>
          <Badge tone={subscriptionTone(user.subscription_status)}>{subscriptionLabel(user.subscription_status)}</Badge>
          <span className={styles.sub}>
            {user.current_period_end ? `종료 ${fmtShortDate(user.current_period_end)}` : '종료일 없음'}
          </span>
        </div>
      </td>
      <td data-label="조건 · 레포" className={styles.num} title={`수집 조건 ${user.query_count}개 / 레포 ${user.repo_count}개`}>
        {formatInt(user.query_count, LOCALE)} / {formatInt(user.repo_count, LOCALE)}개
      </td>
      <td data-label="최근 수집">
        {user.last_etl_at || etl ? (
          <div className={styles.stack}>
            {etl ? <Badge tone={etl.tone}>{etl.label}</Badge> : <Badge tone="warn">결과 미상</Badge>}
            <span className={styles.sub}>{fmtShortDateTime(user.last_etl_at)}</span>
          </div>
        ) : (
          <div className={styles.stack}>
            <Badge tone="neutral">미수집</Badge>
            <span className={styles.sub}>수집 기록 없음</span>
          </div>
        )}
      </td>
      <td data-label="GitHub 토큰">
        {user.token_invalid ? <Badge tone="danger">무효</Badge> : <Badge tone="ok">정상</Badge>}
      </td>
    </tr>
  );
}

function Users({
  refreshKey,
  onForbidden,
}: {
  refreshKey: number;
  onForbidden: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const { resource, retry } = useAdminResource<AdminUsersResult>(
    () => fetchAdminUsers(search, page),
    [search, page],
    refreshKey,
    onForbidden,
  );

  const total = resource.status === 'ok' ? resource.data.total : 0;
  const pageSize = resource.status === 'ok' ? resource.data.page_size || PAGE_SIZE_FALLBACK : PAGE_SIZE_FALLBACK;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  // 새로고침 사이 회원 수가 줄어 현재 페이지가 범위를 벗어나면 마지막 페이지로 옮긴다.
  useEffect(() => {
    if (resource.status === 'ok' && resource.data.items.length === 0 && resource.data.total > 0 && page > lastPage) {
      setPage(lastPage);
    }
  }, [resource, page, lastPage]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = draft.trim();
    setSearch(next);
    setPage(1);
  };

  const clear = () => {
    setDraft('');
    setSearch('');
    setPage(1);
  };

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = resource.status === 'ok' ? (page - 1) * pageSize + resource.data.items.length : 0;

  return (
    <section className={`panel panel--flush ${styles.usersPanel}`} aria-labelledby="admin-users-title">
      <div className={styles.usersHead}>
        <div className={styles.usersTitleRow}>
          <h2 id="admin-users-title" className="panel__title">
            회원
          </h2>
          <span className={styles.panelNote} aria-live="polite">
            {resource.status === 'ok'
              ? search
                ? `“${search}” 검색 결과 ${people(total)}`
                : `전체 ${people(total)}`
              : '\u00a0'}
          </span>
        </div>
        <form className={styles.search} role="search" onSubmit={submit}>
          <label htmlFor="admin-search" className={styles.srOnly}>
            GitHub 로그인명 검색
          </label>
          <input
            id="admin-search"
            type="search"
            className={`input ${styles.searchInput}`}
            value={draft}
            maxLength={100}
            placeholder="GitHub 로그인명으로 검색"
            autoComplete="off"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className={`btn btn--primary ${styles.touch}`}>
            검색
          </button>
          {search && (
            <button type="button" className={`btn ${styles.touch}`} onClick={clear}>
              검색 해제
            </button>
          )}
        </form>
      </div>

      {resource.status === 'loading' && <Loading label="회원 목록을 불러오는 중…" />}
      {resource.status === 'error' && <Failure httpStatus={resource.httpStatus} onRetry={retry} />}
      {resource.status === 'ok' && resource.data.items.length === 0 && resource.data.total === 0 && (
        <div className={styles.state}>
          <div className={styles.stateTitle}>{search ? '검색 결과가 없습니다' : '가입한 회원이 없습니다'}</div>
          <p className={styles.stateText}>
            {search ? `“${search}”와(과) 일치하는 GitHub 로그인명이 없습니다. 검색어를 바꿔 보세요.` : '아직 조회할 회원이 없습니다.'}
          </p>
          {search && (
            <button type="button" className={`btn ${styles.touch}`} onClick={clear}>
              전체 회원 보기
            </button>
          )}
        </div>
      )}
      {resource.status === 'ok' && resource.data.items.length > 0 && (
        <>
          <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="회원 목록 표 · 좁은 화면에서 가로 스크롤">
            <table className={`${styles.table} ${styles.userTable}`}>
              <caption className={styles.caption}>
                가입 최신순 · 페이지당 {pageSize}명 · 모든 시각은 한국 표준시(KST)
              </caption>
              <colgroup>
                <col /><col /><col /><col /><col /><col /><col />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">회원</th>
                  <th scope="col">가입 일시</th>
                  <th scope="col">저장 플랜</th>
                  <th scope="col">구독</th>
                  <th scope="col">조건 / 레포</th>
                  <th scope="col">최근 수집</th>
                  <th scope="col">토큰</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.items.map((u) => (
                  <UserRow key={u.id} user={u} />
                ))}
              </tbody>
            </table>
          </div>
          <nav className={styles.pager} aria-label="회원 목록 페이지">
            <button
              type="button"
              className={`btn ${styles.touch}`}
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← 이전
            </button>
            <span className={styles.pagerInfo} aria-live="polite">
              {page} / {formatInt(lastPage, LOCALE)} 페이지 · {formatInt(from, LOCALE)}–{formatInt(to, LOCALE)}번째
            </span>
            <button
              type="button"
              className={`btn ${styles.touch}`}
              disabled={page >= lastPage}
              onClick={() => setPage((p) => p + 1)}
            >
              다음 →
            </button>
          </nav>
        </>
      )}
    </section>
  );
}

function Feeds({ refreshKey, onForbidden }: { refreshKey: number; onForbidden: () => void }) {
  const { resource, retry } = useAdminResource<AdminFeedsResult>(fetchAdminFeeds, [], refreshKey, onForbidden);
  const feeds = resource.status === 'ok' ? resource.data.items : [];
  const failed = feeds.filter((feed) => feed.last_status === 'error').length;
  const pending = feeds.filter((feed) => !feed.last_status).length;

  return (
    <section className={`panel panel--flush ${styles.usersPanel}`} aria-labelledby="admin-feeds-title">
      <div className={styles.usersHead}>
        <div className={styles.usersTitleRow}>
          <h2 id="admin-feeds-title" className="panel__title">공개 피드 수집 현황</h2>
          <p className={styles.panelNote} aria-live="polite">
            {resource.status === 'ok'
              ? `설정된 피드 ${feeds.length}개 · 실패 ${failed}개 · 미수집 ${pending}개`
              : '현재 설정된 전체·언어·주제 피드'}
          </p>
        </div>
      </div>
      {resource.status === 'loading' && <Loading label="공개 피드 현황을 불러오는 중…" />}
      {resource.status === 'error' && <Failure httpStatus={resource.httpStatus} onRetry={retry} />}
      {resource.status === 'ok' && feeds.length === 0 && (
        <div className={styles.state}><p className={styles.stateTitle}>설정된 공개 피드가 없습니다.</p></div>
      )}
      {resource.status === 'ok' && feeds.length > 0 && (
        <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="공개 피드 표 · 좁은 화면에서 가로 스크롤">
          <table className={styles.table}>
            <caption className={styles.caption}>
              모든 시각은 한국 표준시(KST) · 누적 연결 레포는 전체 저장 연결 수이며 현재 노출 수와 다릅니다
            </caption>
            <thead>
              <tr>
                <th scope="col">피드</th><th scope="col">종류</th>
                <th scope="col">최근 시도</th><th scope="col">최근 성공</th>
                <th scope="col">수집 결과</th><th scope="col">누적 연결 레포</th>
              </tr>
            </thead>
            <tbody>
              {feeds.map((feed) => (
                <tr key={`${feed.kind}:${feed.slug}`}>
                  <td data-label="피드">
                    <div className={styles.cellUser}>
                      <span className={styles.login}>{feed.name.ko}</span>
                      <span className={styles.name}>{feed.slug}</span>
                    </div>
                  </td>
                  <td data-label="종류">{feed.kind === 'all' ? '전체' : feed.kind === 'language' ? '언어' : '주제'}</td>
                  <td data-label="최근 시도" className={styles.nowrap}>{fmtShortDateTime(feed.last_attempt_at)}</td>
                  <td data-label="최근 성공" className={styles.nowrap}>{fmtShortDateTime(feed.last_success_at)}</td>
                  <td data-label="수집 결과">
                    <div className={styles.stack}>
                      <Badge tone={feed.last_status === 'error' ? 'danger' : feed.last_status === 'ok' ? 'ok' : 'neutral'}>
                        {feed.last_status === 'error' ? '실패' : feed.last_status === 'ok' ? '성공' : '미수집'}
                      </Badge>
                      {feed.last_status === 'error' && feed.last_error_code && (
                        <span className={styles.sub}>
                          {feed.last_error_code === 'UNKNOWN_ERROR' ? '기타 오류' : feed.last_error_code}
                        </span>
                      )}
                    </div>
                  </td>
                  <td data-label="누적 연결 레포" className={styles.num}>{formatInt(feed.repo_count, LOCALE)}개</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── 페이지 ───────────────────────────────────────────────────────────────────

function AdminConsole({ onForbidden }: { onForbidden: () => void }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const { resource, retry } = useAdminResource<AdminOverview>(fetchAdminOverview, [], refreshKey, onForbidden);

  return (
    <div className={`page ${styles.root}`} lang="ko">
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.title}>운영 현황</h1>
          <p className={styles.lead}>회원·구독·수집 상태를 한눈에 확인합니다.</p>
        </div>
        <div className={styles.headerSide}>
          <span className={`${styles.badge} ${styles.tone_neutral}`}>조회 전용</span>
          <span className={styles.stamp}>
            {resource.status === 'ok' ? `조회 ${fmtStamp(resource.data.generated_at)}` : '조회 시각 —'}
          </span>
          <button type="button" className={`btn ${styles.touch}`} onClick={() => setRefreshKey((k) => k + 1)}>
            새로고침
          </button>
        </div>
      </header>
      <nav className={styles.sectionLinks} aria-label="운영 현황 섹션">
        <a className={`btn ${styles.touch}`} href="#admin-users-title">회원 바로가기</a>
        <a className={`btn ${styles.touch}`} href="#admin-feeds-title">공개 피드 바로가기</a>
      </nav>

      {resource.status === 'loading' && (
        <div className="panel">
          <Loading label="운영 요약을 불러오는 중…" />
        </div>
      )}
      {resource.status === 'error' && (
        <div className="panel">
          <Failure httpStatus={resource.httpStatus} onRetry={retry} />
        </div>
      )}
      {resource.status === 'ok' && <Overview overview={resource.data} />}

      <Users refreshKey={refreshKey} onForbidden={onForbidden} />
      <Feeds refreshKey={refreshKey} onForbidden={onForbidden} />
    </div>
  );
}

export default function AdminPage() {
  const { me } = useAuth();
  const [forbidden, setForbidden] = useState(false);
  const onForbidden = useCallback(() => setForbidden(true), []);

  if (!me?.isAdmin || forbidden) return <AccessDenied />;
  return <AdminConsole onForbidden={onForbidden} />;
}
