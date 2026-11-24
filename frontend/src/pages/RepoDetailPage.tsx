// RepoDetailPage.tsx — 레포 상세 화면 (화면 ④).
// 레포 정보, 스타 추이 차트, 메모, 북마크/삭제 액션 제공.
import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAsync } from '../lib/useAsync';
import { getRepo, updateRepo, deleteRepo } from '../api/repos';
import { listQueries } from '../api/queries';
import {
  formatDelta,
  formatStars,
  formatInt,
  formatPercent,
  formatRelativeTime,
} from '../lib/format';
import { useToast } from '../components/Toast';
import { LoadingState, ErrorState, EmptyState } from '../components/States';
import ConfirmDialog from '../components/ConfirmDialog';
import StarChart from '../components/StarChart';
import type { WatchQuery } from '../types';
import styles from './RepoDetailPage.module.css';
import { useTranslation } from 'react-i18next';
import { toSupportedLocale } from '../i18n';

export default function RepoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const repoId = Number(id);
  const nav = useNavigate();
  const toast = useToast();
  const { t, i18n } = useTranslation();
  const locale = toSupportedLocale(i18n.resolvedLanguage) ?? 'en';

  // 레포 데이터 패칭
  const { data, loading, error, reload, setData } = useAsync(
    () => getRepo(repoId),
    [repoId],
  );

  // 쿼리 목록 (context line 용, 실패해도 무시)
  const [queries, setQueries] = useState<WatchQuery[]>([]);
  useEffect(() => {
    listQueries()
      .then(setQueries)
      .catch(() => {
        /* 무시 — non-blocking */
      });
  }, []);

  // 메모 상태
  const [note, setNote] = useState('');
  const [noteDirty, setNoteDirty] = useState(false);
  const [savingNote, setSavingNote] = useState(false);

  // repo.note 가 로드되면 note state 동기화
  useEffect(() => {
    if (data?.repo) {
      setNote(data.repo.note ?? '');
      setNoteDirty(false);
    }
  }, [data?.repo]);

  // 삭제 다이얼로그
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // ── 로딩 / 에러 상태 ────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="page">
        <LoadingState />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <ErrorState message={error} onRetry={reload} />
        <div style={{ marginTop: 'var(--gap)' }}>
          <Link to="/repos" className="btn btn--sm btn--ghost">
            ← {t('detail.back')}
          </Link>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { repo, snapshots } = data;

  // 최신 스냅샷 (마지막 원소) 및 기간 변화량
  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const netStarChange = snapshots.length >= 2
    ? snapshots[snapshots.length - 1].stars - snapshots[0].stars
    : null;

  async function handleCopyUrl() {
    try {
      await navigator.clipboard.writeText(repo.html_url);
      toast.info(t('detail.copiedUrl'));
    } catch {
      toast.error(t('errors.generic'));
    }
  }

  // 연결된 쿼리 이름
  const matchedQuery = queries.find((q) => q.id === repo.query_id);
  const queryLabel = matchedQuery
    ? `${matchedQuery.query} (${t(matchedQuery.query_type === 'topic' ? 'queries.topicShort' : 'queries.keywordShort')})`
    : null;

  // ── 메모 저장 ────────────────────────────────────────────────────────────
  async function handleSaveNote() {
    setSavingNote(true);
    try {
      const updated = await updateRepo(repoId, { note });
      setData((prev) =>
        prev
          ? { ...prev, repo: { ...prev.repo, note: updated.note } }
          : { repo: updated, snapshots: [] },
      );
      setNoteDirty(false);
      toast.success(t('detail.noteSaved'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('errors.generic');
      toast.error(msg);
    } finally {
      setSavingNote(false);
    }
  }

  // ── 북마크 토글 ──────────────────────────────────────────────────────────
  async function handleBookmark() {
    const next = !repo.is_bookmarked;
    try {
      const updated = await updateRepo(repoId, { is_bookmarked: next });
      setData((prev) =>
        prev
          ? { ...prev, repo: { ...prev.repo, is_bookmarked: updated.is_bookmarked } }
          : { repo: updated, snapshots: [] },
      );
      toast.success(t(next ? 'detail.savedToast' : 'detail.unsavedToast'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('errors.generic');
      toast.error(msg);
    }
  }

  // ── 삭제 ────────────────────────────────────────────────────────────────
  async function handleDelete() {
    setDeleteBusy(true);
    try {
      await deleteRepo(repoId);
      toast.success(t('detail.deleted', { name: repo.full_name }));
      nav('/repos');
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('errors.generic');
      toast.error(msg);
      setDeleteBusy(false);
      setDeleteOpen(false);
    }
  }

  // ── growth rate pill 색 ───────────────────────────────────────────────
  const growthClass =
    repo.growth_rate > 0 ? 'pill pill--accent' : repo.growth_rate < 0 ? 'pill' : 'pill';

  return (
    <div className="page stagger">
      {/* ── 상단 바 ───────────────────────────────────────────────────── */}
      <div className={`spread ${styles.topBar}`}>
        <button className="btn btn--sm" onClick={() => nav('/repos')}>
          ← {t('detail.back')}
        </button>
        {queryLabel && (
          <span className={`mono muted ${styles.contextLine}`}>
            {t('detail.filterContext', { name: queryLabel })}
          </span>
        )}
      </div>

      {/* ── 본문 2컬럼 ───────────────────────────────────────────────── */}
      <div className={`row ${styles.body}`}>
        {/* 왼쪽 col (flex:2) */}
        <div className={`col ${styles.leftCol}`}>
          {/* 정보 패널 */}
          <div className="panel">
            <div className={styles.titleRow}>
              <h1 className={styles.repoName}>
                <a
                  href={repo.html_url}
                  target="_blank"
                  rel="noreferrer"
                  className="link mono"
                >
                  {repo.full_name} ↗
                </a>
              </h1>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={handleCopyUrl}
              >
                {t('detail.copyUrl')}
              </button>
            </div>
            {repo.description ? (
              <p className={`muted ${styles.description}`}>{repo.description}</p>
            ) : (
              <p className={`faint ${styles.description}`}>{t('detail.noDescription')}</p>
            )}

            <div className={`row wrap ${styles.pills}`}>
              <span className="pill">{repo.language ?? '—'}</span>
              <span className="pill">★ {formatStars(repo.stars, locale)}</span>
              {latest && (
                <>
                  <span className="pill">⑂ {formatInt(latest.forks, locale)}</span>
                  <span className="pill">◔ {t('detail.issues', { count: formatInt(latest.open_issues, locale) })}</span>
                </>
              )}
              {repo.growth_rate !== 0 && (
                <span className={growthClass}>
                  {formatPercent(repo.growth_rate, 1, locale)}
                </span>
              )}
              {repo.star_delta !== 0 && (
                <span
                  className={
                    repo.star_delta > 0 ? 'pill pill--accent' : `pill ${styles.deltaDown}`
                  }
                >
                  {t('dashboard.table.increase')} {formatStars(Math.abs(repo.star_delta), locale)}
                </span>
              )}
            </div>

            {repo.first_seen_at && (
              <div className={`muted ${styles.metaLine}`}>
                <span className="mono faint" style={{ fontSize: 11 }}>
                  {t('detail.firstSeen', { time: formatRelativeTime(repo.first_seen_at, locale) })}
                </span>
              </div>
            )}
          </div>

          {/* 스타 추이 패널 */}
          <div className="panel">
            <div className="panel__head">
              <span className="panel__title">{t('detail.historyTitle')}</span>
              <div className="center">
                {netStarChange !== null && netStarChange !== 0 && (
                  <span className={`pill ${netStarChange > 0 ? 'pill--accent' : ''}`}>
                    {t('detail.netChange', { delta: formatDelta(netStarChange, locale) })}
                  </span>
                )}
                {snapshots.length > 0 && (
                  <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--mono)' }}>
                    {t('detail.records', { count: formatInt(snapshots.length, locale) })}
                  </span>
                )}
              </div>
            </div>
            {snapshots.length <= 1 ? (
              <EmptyState
                icon="◌"
                title={t('detail.collectingTitle')}
                hint={t('detail.collectingHint')}
              />
            ) : (
              <StarChart snapshots={snapshots} />
            )}
          </div>
        </div>

        {/* 오른쪽 col */}
        <div className={`col ${styles.rightCol}`}>
          {/* 메모 패널 */}
          <div className="panel">
            <div className="panel__head">
              <label className="label" htmlFor="repo-note">
                {t('detail.note')}
              </label>
              {noteDirty && (
                <span className={`mono ${styles.dirtyBadge}`}>{t('detail.unsaved')}</span>
              )}
            </div>
            <textarea
              id="repo-note"
              className="textarea"
              value={note}
              placeholder={t('detail.notePlaceholder')}
              disabled={savingNote}
              onChange={(e) => {
                setNote(e.target.value);
                setNoteDirty(true);
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && noteDirty && !savingNote) {
                  e.preventDefault();
                  void handleSaveNote();
                }
              }}
            />
            <div className={`spread ${styles.noteFooter}`}>
              <button
                className="btn btn--primary btn--sm"
                onClick={handleSaveNote}
                disabled={savingNote || !noteDirty}
              >
                {savingNote ? t('detail.saving') : t('common.save')}
              </button>
              <span className="mono faint" style={{ fontSize: 11 }}>
                {t('detail.saveShortcut')}
              </span>
            </div>
          </div>

          {/* 액션 패널 */}
          <div className="panel">
            <div className="panel__head">
              <span className="panel__title">{t('detail.actions')}</span>
            </div>
            <div className={`stack ${styles.actions}`}>
              <button
                className={`btn ${repo.is_bookmarked ? 'btn--active' : ''}`}
                onClick={handleBookmark}
              >
                {t(repo.is_bookmarked ? 'detail.saved' : 'detail.save')}
              </button>
              <button
                className="btn btn--danger"
                onClick={() => setDeleteOpen(true)}
              >
                {t('detail.delete')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 삭제 확인 다이얼로그 */}
      <ConfirmDialog
        open={deleteOpen}
        message={t('detail.deleteMessage', { name: repo.full_name })}
        title={t('detail.delete')}
        confirmLabel={t('common.delete')}
        busy={deleteBusy}
        onConfirm={handleDelete}
        onCancel={() => setDeleteOpen(false)}
      />
    </div>
  );
}
