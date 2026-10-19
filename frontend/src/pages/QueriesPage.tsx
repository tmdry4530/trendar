// QueriesPage.tsx — 검색 조건(WatchQuery) CRUD 페이지.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { listQueries, updateQuery, deleteQuery } from '../api/queries';
import { runEtl, getEtlStatus } from '../api/stats';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useAsync } from '../lib/useAsync';
import { formatInt, formatDate } from '../lib/format';
import { useToast } from '../components/Toast';
import { LoadingState, EmptyState, ErrorState } from '../components/States';
import ConfirmDialog from '../components/ConfirmDialog';
import QueryForm from '../components/QueryForm';
import Help from '../components/Help';
import type { WatchQuery, QueryType, EtlStatus } from '../types';
import styles from './QueriesPage.module.css';
import { useTranslation } from 'react-i18next';
import { toSupportedLocale } from '../i18n';

// ── Types ────────────────────────────────────────────────────────────────────

interface EditState {
  id: number;
  query: string;
  queryType: QueryType;
  saving: boolean;
}

interface DeleteState {
  id: number;
  query: string;
  busy: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function QueriesPage() {
  const toast = useToast();
  const { me } = useAuth();
  const { t, i18n } = useTranslation();
  const locale = toSupportedLocale(i18n.resolvedLanguage) ?? 'en';
  const { data, loading, error, reload } = useAsync<WatchQuery[]>(
    () => listQueries(),
    [],
  );

  // Global ETL state
  const [etlRunning, setEtlRunning] = useState(false);

  // 수동 수집 일일 한도 (배지 표시 + 버튼 게이트)
  const { data: etl, reload: reloadEtl } = useAsync<EtlStatus>(() => getEtlStatus(), []);
  const quotaExhausted = etl !== null && etl.manual_remaining === 0;
  const quotaTooltip = quotaExhausted
    ? t('queries.quotaExhausted')
    : t('queries.quotaReset');

  // Free 사용자가 한도에 걸리면 업그레이드 안내 (Pro 에게는 표시하지 않음)
  const [limitHit, setLimitHit] = useState<'query' | 'etl' | null>(null);
  const upgradeReason = me?.plan === 'pro' ? null : limitHit ?? (quotaExhausted ? 'etl' : null);
  const noteEtlLimit = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'ETL_DAILY_LIMIT_EXCEEDED') setLimitHit('etl');
  };

  // Per-row ETL running ids
  const [rowEtlId, setRowEtlId] = useState<number | null>(null);

  // Inline edit state (one row at a time)
  const [editState, setEditState] = useState<EditState | null>(null);

  // Delete confirm state
  const [deleteState, setDeleteState] = useState<DeleteState | null>(null);

  // Active toggle optimistic update set (ids being toggled)
  const [togglingIds, setTogglingIds] = useState<Set<number>>(new Set());

  function collectionResultMessage(result: Awaited<ReturnType<typeof runEtl>>) {
    const base = t('queries.completed', {
      projects: formatInt(result.repos_upserted, locale),
      records: formatInt(result.snapshots_inserted, locale),
    });
    return result.repos_skipped
      ? `${base}${t('queries.completedSkipped', { count: formatInt(result.repos_skipped, locale) })}`
      : base;
  }

  // ── Global ETL ─────────────────────────────────────────────────────────────

  async function handleRunAllEtl() {
    setEtlRunning(true);
    try {
      const result = await runEtl();
      toast.success(collectionResultMessage(result));
      reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('errors.generic');
      toast.error(msg);
      noteEtlLimit(err);
    } finally {
      setEtlRunning(false);
      reloadEtl(); // 잔여 한도 동기화 (429 포함)
    }
  }

  // ── Per-row ETL ────────────────────────────────────────────────────────────

  async function handleRowEtl(id: number) {
    setRowEtlId(id);
    try {
      const result = await runEtl(id);
      toast.success(collectionResultMessage(result));
      reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('errors.generic');
      toast.error(msg);
      noteEtlLimit(err);
    } finally {
      setRowEtlId(null);
      reloadEtl(); // 잔여 한도 동기화 (429 포함)
    }
  }

  // ── Active toggle ──────────────────────────────────────────────────────────

  async function handleToggleActive(row: WatchQuery) {
    if (togglingIds.has(row.id)) return;
    setTogglingIds((prev) => new Set(prev).add(row.id));
    try {
      await updateQuery(row.id, { is_active: !row.is_active });
      toast.success(t(!row.is_active ? 'queries.enabled' : 'queries.disabled', { name: row.query }));
      reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('errors.generic');
      toast.error(msg);
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
    }
  }

  // ── Inline edit ────────────────────────────────────────────────────────────

  function startEdit(row: WatchQuery) {
    setEditState({ id: row.id, query: row.query, queryType: row.query_type, saving: false });
  }

  function cancelEdit() {
    setEditState(null);
  }

  async function commitEdit() {
    if (!editState) return;
    const trimmed = editState.query.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      toast.error(t('queries.validation'));
      return;
    }
    setEditState((s) => s ? { ...s, saving: true } : s);
    try {
      await updateQuery(editState.id, { query: trimmed, query_type: editState.queryType });
      toast.success(t('queries.updated'));
      setEditState(null);
      reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('errors.generic');
      toast.error(msg);
      setEditState((s) => s ? { ...s, saving: false } : s);
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  function openDelete(row: WatchQuery) {
    setDeleteState({ id: row.id, query: row.query, busy: false });
  }

  function cancelDelete() {
    setDeleteState(null);
  }

  async function confirmDelete() {
    if (!deleteState) return;
    setDeleteState((s) => s ? { ...s, busy: true } : s);
    try {
      await deleteQuery(deleteState.id);
      toast.success(t('queries.deleted', { name: deleteState.query }));
      setDeleteState(null);
      reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('errors.generic');
      toast.error(msg);
      setDeleteState((s) => s ? { ...s, busy: false } : s);
    }
  }

  // ── Render helpers ─────────────────────────────────────────────────────────

  function renderQueryCell(row: WatchQuery) {
    if (editState?.id === row.id) {
      return (
        <div className={styles.editRow}>
          <input
            className={`input ${styles.editInput}`}
            value={editState.query}
            onChange={(e) =>
              setEditState((s) => s ? { ...s, query: e.target.value } : s)
            }
            disabled={editState.saving}
            maxLength={200}
            autoFocus
            aria-label={t('queries.editLabel')}
          />
          <select
            className={`select ${styles.editSelect}`}
            value={editState.queryType}
            onChange={(e) =>
              setEditState((s) =>
                s ? { ...s, queryType: e.target.value as QueryType } : s,
              )
            }
            disabled={editState.saving}
            aria-label={t('queries.typeEditLabel')}
          >
            <option value="keyword">{t('queries.keyword')}</option>
            <option value="topic">{t('queries.topic')}</option>
          </select>
        </div>
      );
    }
    return <span className="truncate">{row.query}</span>;
  }

  function renderTypeCell(row: WatchQuery) {
    if (editState?.id === row.id) {
      // type is shown inside the edit row in queryCell
      return null;
    }
    return (
      <span className={`pill ${row.query_type === 'topic' ? 'pill--topic' : 'pill--keyword'}`}>
        {t(row.query_type === 'topic' ? 'queries.topicShort' : 'queries.keywordShort')}
      </span>
    );
  }

  function renderStatusCell(row: WatchQuery) {
    if (editState?.id === row.id) return null;
    const isToggling = togglingIds.has(row.id);
    return (
      <button
        type="button"
        className={`${styles.statusToggle}${row.is_active ? ` ${styles.statusOn}` : ''}`}
        onClick={() => handleToggleActive(row)}
        disabled={isToggling}
        title={t(row.is_active ? 'queries.deactivate' : 'queries.activate')}
        aria-pressed={row.is_active}
      >
        {isToggling ? (
          <span className="spinner" style={{ width: 10, height: 10 }} />
        ) : (
          <span className={row.is_active ? 'dot' : 'dot dot--off'} />
        )}
        {t(row.is_active ? 'queries.active' : 'queries.inactive')}
      </button>
    );
  }

  function renderActionsCell(row: WatchQuery) {
    const isEditing = editState?.id === row.id;
    const isSaving = editState?.id === row.id && editState.saving;
    const isRowEtlRunning = rowEtlId === row.id;

    if (isEditing) {
      return (
        <div className={styles.actionsGap}>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={commitEdit}
            disabled={isSaving}
          >
            {isSaving ? <span className="spinner" /> : null}
            {t('common.save')}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={cancelEdit}
            disabled={isSaving}
          >
            {t('common.cancel')}
          </button>
        </div>
      );
    }

    return (
      <div className={styles.actionsGap}>
        {/* Edit */}
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => startEdit(row)}
          disabled={editState !== null || isRowEtlRunning}
        >
          {t('common.edit')}
        </button>

        {/* Per-row ETL */}
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => handleRowEtl(row.id)}
          disabled={isRowEtlRunning || editState !== null || etlRunning || quotaExhausted}
          title={quotaExhausted ? quotaTooltip : t('queries.runOne')}
          aria-label={t('queries.runOneLabel')}
        >
          {isRowEtlRunning ? (
            <span className={styles.etlSpinner}>
              <span className="spinner" style={{ width: 10, height: 10 }} />
            </span>
          ) : (
            '▶'
          )}
        </button>

        {/* Delete */}
        <button
          type="button"
          className="btn btn--danger btn--sm"
          onClick={() => openDelete(row)}
          disabled={editState !== null || isRowEtlRunning}
        >
          {t('common.delete')}
        </button>
      </div>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────

  return (
    <div className="page">
      {/* Header */}
      <div className={styles.headerRow}>
        <div className={`page__title ${styles.title}`}>{t('queries.title')}</div>
        <div className={styles.etlControls}>
          <Help
            text={t('queries.collectionHelp')}
            label={t('queries.collectionHelpLabel')}
          />
          {etl !== null && (
            <span
              className={quotaExhausted ? 'pill pill--accent' : 'pill'}
              title={quotaTooltip}
            >
              {t('queries.quota', { used: etl.manual_used_today, limit: etl.manual_limit })}
            </span>
          )}
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleRunAllEtl}
            disabled={etlRunning || quotaExhausted}
            title={quotaExhausted ? quotaTooltip : undefined}
          >
            {etlRunning ? <span className="spinner" /> : null}
            {t('queries.runAll')}
          </button>
        </div>
      </div>

      {/* New query form */}
      <div className="stack">
        {upgradeReason && (
          <div className={styles.upgradeNotice} role="status">
            <span>
              {t(upgradeReason === 'query' ? 'errors.queryLimit' : 'errors.rateLimit')}{' '}
              {t('queries.limitUpgrade')}
            </span>
            <Link to="/account/billing" className="btn btn--primary btn--sm">
              {t('queries.limitUpgradeLink')}
            </Link>
          </div>
        )}

        <QueryForm onCreated={reload} onLimitExceeded={() => setLimitHit('query')} />

        {/* List panel */}
        <div className="panel panel--flush">
          {loading && <LoadingState />}

          {!loading && error && (
            <ErrorState message={error} onRetry={reload} />
          )}

          {!loading && !error && data !== null && data.length === 0 && (
            <EmptyState
              title={t('queries.emptyTitle')}
              hint={
                <>
                  {t('queries.emptyHint')}
                  <br />
                  {t('queries.emptySteps')}
                </>
              }
            />
          )}

          {!loading && !error && data !== null && data.length > 0 && (
            <div className={styles.tableWrap}>
              <table className="table table--rows table--center">
                <thead>
                  <tr>
                    <th>{t('queries.columns.query')}</th>
                    <th>
                      {t('queries.columns.type')}{' '}
                      <Help text={t('queries.columns.typeHelp')} label={t('queries.columns.typeHelpLabel')} />
                    </th>
                    <th>{t('queries.columns.status')}</th>
                    <th>{t('queries.columns.projects')}</th>
                    <th>{t('queries.columns.created')}</th>
                    <th>{t('queries.columns.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((row) => (
                    <tr key={row.id}>
                      <td className={styles.queryCell}>
                        {renderQueryCell(row)}
                      </td>
                      <td>{renderTypeCell(row)}</td>
                      <td>{renderStatusCell(row)}</td>
                      <td>
                        <span className="num">{formatInt(row.repo_count, locale)}</span>
                      </td>
                      <td>
                        <span className="num muted">
                          {formatDate(row.created_at, locale)}
                        </span>
                      </td>
                      <td className={styles.actionsCell}>
                        {renderActionsCell(row)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Delete confirm dialog */}
      <ConfirmDialog
        open={deleteState !== null}
        title={t('queries.deleteTitle')}
        message={
          deleteState
            ? t('queries.deleteMessage', { name: deleteState.query })
            : ''
        }
        confirmLabel={t('common.delete')}
        danger
        busy={deleteState?.busy ?? false}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
    </div>
  );
}
