// ReposPage.tsx — 레포 목록 페이지 (화면 ③).
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../lib/useAsync';
import { listRepos, updateRepo, deleteRepo } from '../api/repos';
import { listQueries } from '../api/queries';
import { formatInt } from '../lib/format';
import { useToast } from '../components/Toast';
import { LoadingState, EmptyState, ErrorState } from '../components/States';
import ConfirmDialog from '../components/ConfirmDialog';
import RepoRow from '../components/RepoRow';
import type { Repo, RepoQueryParams, RepoSort, RepoListResult } from '../types';
import styles from './ReposPage.module.css';

const LIMIT = 30;

export default function ReposPage() {
  const toast = useToast();

  // ── filter state ────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [queryId, setQueryId] = useState<number | undefined>(undefined);
  const [sort, setSort] = useState<RepoSort>('stars');
  const [bookmarked, setBookmarked] = useState(false);
  const [offset, setOffset] = useState(0);

  // debounce search ~300ms
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // reset offset when filters change (except offset itself)
  useEffect(() => {
    setOffset(0);
  }, [queryId, sort, bookmarked]);

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
      toast.success(`'${deleteTarget.full_name}' 삭제 완료`);
      setDeleteTarget(null);
      reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '삭제 중 오류가 발생했습니다.';
      toast.error(msg);
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteTarget, toast, reload]);

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
        toast.info(next ? '북마크 추가' : '북마크 해제');
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
        const msg = err instanceof Error ? err.message : '북마크 업데이트 실패';
        toast.error(msg);
      }
    },
    [setData, toast],
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
      <div className="page__title">REPOS</div>

      {/* toolbar */}
      <div className={`panel ${styles.toolbar}`}>
        <div className="row wrap">
          {/* search */}
          <input
            className={`input ${styles.searchInput}`}
            type="search"
            placeholder="레포명 / 설명 검색…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="레포 검색"
          />

          {/* query filter */}
          <select
            className={`select ${styles.filterSelect}`}
            value={queryId ?? ''}
            onChange={(e) => setQueryId(e.target.value ? Number(e.target.value) : undefined)}
            aria-label="조건 필터"
          >
            <option value="">전체</option>
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
            onChange={(e) => setSort(e.target.value as RepoSort)}
            aria-label="정렬 기준"
          >
            <option value="stars">스타순</option>
            <option value="growth">성장률순</option>
            <option value="recent">최근수집순</option>
          </select>

          {/* bookmark toggle */}
          <button
            type="button"
            className={`btn ${bookmarked ? 'btn--active' : ''}`}
            onClick={() => setBookmarked((b) => !b)}
            aria-pressed={bookmarked}
          >
            ★ 북마크만
          </button>
        </div>
      </div>

      {/* states */}
      {loading && <LoadingState />}
      {error && <ErrorState message={error} onRetry={reload} />}

      {!loading && !error && data && (
        <>
          {data.items.length === 0 ? (
            filtersActive ? (
              <EmptyState
                title="검색 결과가 없습니다"
                hint="필터를 조정해 보세요"
              />
            ) : (
              <EmptyState
                title="수집된 레포가 없습니다"
                hint="Queries에서 조건을 추가하고 ETL을 실행하세요"
                action={
                  <Link className="btn btn--sm btn--primary" to="/queries">
                    조건 관리로
                  </Link>
                }
              />
            )
          ) : (
            <div className={`panel panel--flush ${styles.tableWrap}`}>
              <table className="table table--rows">
                <thead>
                  <tr>
                    <th aria-label="북마크" />
                    <th>Repo / Description</th>
                    <th>Lang</th>
                    <th className="col-num">Stars</th>
                    <th className="col-num">Δ 성장</th>
                    <th aria-label="삭제" />
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
                {formatInt(total)}건 &nbsp;
                <span className="faint">
                  ({rangeStart}–{rangeEnd})
                </span>
              </span>
              <div className="row">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={!hasPrev}
                  onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}
                >
                  이전
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={!hasNext}
                  onClick={() => setOffset((o) => o + LIMIT)}
                >
                  다음
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* delete confirm */}
      <ConfirmDialog
        open={deleteTarget !== null}
        message={deleteTarget ? `'${deleteTarget.full_name}' 레포와 스냅샷을 삭제합니다.` : ''}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
        busy={deleteBusy}
      />
    </div>
  );
}
