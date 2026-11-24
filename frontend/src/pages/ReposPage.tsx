// ReposPage.tsx — 레포 목록 페이지 (화면 ③).
import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAsync } from '../lib/useAsync';
import { listRepos, updateRepo, deleteRepo } from '../api/repos';
import { listQueries } from '../api/queries';
import { formatInt } from '../lib/format';
import { useToast } from '../components/Toast';
import { EmptyState, ErrorState, TableSkeleton } from '../components/States';
import ConfirmDialog from '../components/ConfirmDialog';
import RepoRow from '../components/RepoRow';
import Help from '../components/Help';
import type { Repo, RepoQueryParams, RepoSort, RepoListResult } from '../types';
import styles from './ReposPage.module.css';
import { useTranslation } from 'react-i18next';
import { toSupportedLocale } from '../i18n';

const LIMIT = 30;
const VALID_SORTS = new Set<RepoSort>(['stars', 'growth', 'recent']);

function parseSortParam(raw: string | null): RepoSort {
  return raw && VALID_SORTS.has(raw as RepoSort) ? (raw as RepoSort) : 'stars';
}

function parseIntParam(raw: string | null): number | undefined {
  if (!raw || !/^[1-9]\d*$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

function parseOffsetParam(raw: string | null): number {
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

export default function ReposPage() {
  const toast = useToast();
  const { t, i18n } = useTranslation();
  const locale = toSupportedLocale(i18n.resolvedLanguage) ?? 'en';
  const [searchParams, setSearchParams] = useSearchParams();

  // ── filter state (URL 쿼리 파라미터와 동기화해 뒤로가기·새로고침 시 유지) ──
  const initialSearch = searchParams.get('search') ?? '';
  const [search, setSearch] = useState(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch);
  const [queryId, setQueryId] = useState<number | undefined>(() => parseIntParam(searchParams.get('query_id')));
  const [sort, setSort] = useState<RepoSort>(() => parseSortParam(searchParams.get('sort')));
  const [bookmarked, setBookmarked] = useState(() => searchParams.get('bookmarked') === 'true');
  const [offset, setOffset] = useState(() => parseOffsetParam(searchParams.get('offset')));

  // debounce search ~300ms
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch((prev) => {
        if (prev !== search) setOffset(0);
        return search;
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // sync state -> URL search params
  useEffect(() => {
    const next = new URLSearchParams();
    if (debouncedSearch.trim()) next.set('search', debouncedSearch.trim());
    if (queryId !== undefined) next.set('query_id', String(queryId));
    if (sort !== 'stars') next.set('sort', sort);
    if (bookmarked) next.set('bookmarked', 'true');
    if (offset > 0) next.set('offset', String(offset));
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [debouncedSearch, queryId, sort, bookmarked, offset, searchParams, setSearchParams]);

  const handleResetFilters = useCallback(() => {
    setSearch('');
    setDebouncedSearch('');
    setQueryId(undefined);
    setSort('stars');
    setBookmarked(false);
    setOffset(0);
  }, []);

  // ── queries dropdown ─────────────────────────────────────────────────────
  const { data: queriesData } = useAsync(() => listQueries(), []);

  // ── repo list fetch ──────────────────────────────────────────────────────
  const params: RepoQueryParams = {
    search: debouncedSearch || undefined,
    query_id: queryId,
    sort,
    bookmarked: bookmarked || undefined,
    limit: LIMIT,
    offset,
  };

  const {
    data,
    loading,
    error,
    reload,
    setData,
  } = useAsync<RepoListResult>(
    () => listRepos(params),
    [debouncedSearch, queryId, sort, bookmarked, offset],
  );

  // ── delete confirm dialog ────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<Repo | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const handleDeleteRequest = useCallback((repo: Repo) => {
    setDeleteTarget(repo);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await deleteRepo(deleteTarget.id);
      toast.success(t('projects.deleted', { name: deleteTarget.full_name }));
      setDeleteTarget(null);
      reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('errors.generic');
      toast.error(msg);
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteTarget, toast, reload, t]);

  const handleDeleteCancel = useCallback(() => {
    if (!deleteBusy) setDeleteTarget(null);
  }, [deleteBusy]);

  // ── bookmark toggle ──────────────────────────────────────────────────────
  const handleToggleBookmark = useCallback(
    async (repo: Repo) => {
      const next = !repo.is_bookmarked;

      // optimistic update
      setData((prev) => {
        if (!prev) return { items: [], total: 0 };
        return {
          ...prev,
          items: prev.items.map((r) =>
            r.id === repo.id ? { ...r, is_bookmarked: next } : r,
          ),
        };
      });

      try {
        await updateRepo(repo.id, { is_bookmarked: next });
        toast.info(t(next ? 'projects.saved' : 'projects.unsaved'));
      } catch (err) {
        // revert on error
        setData((prev) => {
          if (!prev) return { items: [], total: 0 };
          return {
            ...prev,
            items: prev.items.map((r) =>
              r.id === repo.id ? { ...r, is_bookmarked: repo.is_bookmarked } : r,
            ),
          };
        });
        const msg = err instanceof Error ? err.message : t('errors.generic');
        toast.error(msg);
      }
    },
    [setData, toast, t],
  );

  // ── open row ─────────────────────────────────────────────────────────────
  // RepoRow handles navigation internally via useNavigate; this callback is a no-op hook for parent.
  const handleOpen = useCallback((_id: number) => { /* no-op */ }, []);

  // ── pagination ───────────────────────────────────────────────────────────
  const total = data?.total ?? 0;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + LIMIT, total);
  const hasPrev = offset > 0;
  const hasNext = offset + LIMIT < total;

  const filtersActive = !!(debouncedSearch || queryId || bookmarked);

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <div className="page">
      <div className="page__title">{t('projects.title')}</div>

      {/* toolbar */}
      <div className={`panel ${styles.toolbar}`}>
        <div className={styles.searchWrap}>
          <svg
            className={styles.searchIcon}
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.5" />
            <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            className={`input ${styles.searchInput}`}
            type="search"
            placeholder={t('projects.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t('projects.searchLabel')}
          />
          {search && (
            <button
              type="button"
              className={styles.clearBtn}
              onClick={() => {
                setSearch('');
                setDebouncedSearch('');
                setOffset(0);
              }}
              aria-label={t('projects.clearSearch')}
              title={t('projects.clearSearch')}
            >
              ×
            </button>
          )}
        </div>
        <div className={styles.filterRow}>
          {/* query filter */}
          <select
            className={`select ${styles.filterSelect}`}
            value={queryId ?? ''}
            onChange={(e) => {
              setQueryId(e.target.value ? Number(e.target.value) : undefined);
              setOffset(0);
            }}
            aria-label={t('projects.filterLabel')}
          >
            <option value="">{t('projects.allFilters')}</option>
            {queriesData?.map((q) => (
              <option key={q.id} value={q.id}>
                {q.query}
              </option>
            ))}
          </select>

          {/* sort */}
          <select
            className={`select ${styles.filterSelect}`}
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as RepoSort);
              setOffset(0);
            }}
            aria-label={t('projects.sortLabel')}
          >
            <option value="stars">{t('projects.sortStars')}</option>
            <option value="growth">{t('projects.sortGrowth')}</option>
            <option value="recent">{t('projects.sortRecent')}</option>
          </select>

          {/* bookmark toggle */}
          <button
            type="button"
            className={`btn ${bookmarked ? 'btn--active' : ''}`}
            onClick={() => {
              setBookmarked((b) => !b);
              setOffset(0);
            }}
            aria-pressed={bookmarked}
          >
            ★ {t('projects.savedOnly')}
          </button>

          {(filtersActive || sort !== 'stars') && (
            <button
              type="button"
              className={`btn btn--ghost btn--sm ${styles.resetBtn}`}
              onClick={handleResetFilters}
            >
              ↺ {t('projects.resetFilters')}
            </button>
          )}
        </div>
      </div>

      {/* states */}
      {loading && (
        <div className={`panel panel--flush ${styles.tableWrap}`}>
          <TableSkeleton rows={8} columns={5} />
        </div>
      )}
      {error && <ErrorState message={error} onRetry={reload} />}

      {!loading && !error && data && (
        <>
          {data.items.length === 0 ? (
            filtersActive ? (
              <EmptyState
                title={t('projects.noResults')}
                hint={t('projects.adjustFilters')}
                action={
                  <button type="button" className="btn btn--sm" onClick={handleResetFilters}>
                    ↺ {t('projects.resetFilters')}
                  </button>
                }
              />
            ) : (
              <EmptyState
                title={t('projects.empty')}
                hint={
                  <>
                    {t('projects.emptyHint')}
                    <br />
                    {t('projects.emptySteps')}
                  </>
                }
                action={
                  <Link className="btn btn--sm btn--primary" to="/queries">
                    {t('projects.goToFilters')}
                  </Link>
                }
              />
            )
          ) : (
            <div className={`panel panel--flush ${styles.tableWrap}`}>
              <table className="table table--rows">
                <thead>
                  <tr>
                    <th aria-label={t('projects.savedOnly')} />
                    <th>{t('projects.columns.project')}</th>
                    <th>{t('projects.columns.language')}</th>
                    <th className="col-num">{t('projects.columns.stars')}</th>
                    <th className="col-num">
                      {t('projects.columns.growth')}{' '}
                      <Help text={t('projects.columns.growthHelp')} label={t('projects.columns.growthHelpLabel')} />
                    </th>
                    <th aria-label={t('common.delete')} />
                  </tr>
                </thead>
                <tbody className="stagger">
                  {data.items.map((repo) => (
                    <RepoRow
                      key={repo.id}
                      repo={repo}
                      onOpen={handleOpen}
                      onToggleBookmark={handleToggleBookmark}
                      onDelete={handleDeleteRequest}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* pagination footer */}
          {total > 0 && (
            <div className={`spread ${styles.pagination}`}>
              <span className="muted mono">
                {t('projects.count', {
                  total: formatInt(total, locale),
                  start: formatInt(rangeStart, locale),
                  end: formatInt(rangeEnd, locale),
                })}
              </span>
              <div className="row">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={!hasPrev}
                  onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}
                >
                  {t('common.previous')}
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={!hasNext}
                  onClick={() => setOffset((o) => o + LIMIT)}
                >
                  {t('common.next')}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* delete confirm */}
      <ConfirmDialog
        open={deleteTarget !== null}
        message={deleteTarget ? t('projects.deleteMessage', { name: deleteTarget.full_name }) : ''}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
        busy={deleteBusy}
      />
    </div>
  );
}
