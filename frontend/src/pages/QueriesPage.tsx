// QueriesPage.tsx — 검색 조건(WatchQuery) CRUD 페이지.
import { useState } from 'react';
import { listQueries, updateQuery, deleteQuery } from '../api/queries';
import { runEtl, getEtlStatus } from '../api/stats';
import { useAsync } from '../lib/useAsync';
import { formatInt, formatDate } from '../lib/format';
import { useToast } from '../components/Toast';
import { LoadingState, EmptyState, ErrorState } from '../components/States';
import ConfirmDialog from '../components/ConfirmDialog';
import QueryForm from '../components/QueryForm';
import Help from '../components/Help';
import type { WatchQuery, QueryType, EtlStatus } from '../types';
import styles from './QueriesPage.module.css';

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
    ? '오늘 수동 수집 한도를 모두 사용했습니다 · KST 자정에 초기화됩니다'
    : 'KST 자정에 초기화됩니다';

  // Per-row ETL running ids
  const [rowEtlId, setRowEtlId] = useState<number | null>(null);

  // Inline edit state (one row at a time)
  const [editState, setEditState] = useState<EditState | null>(null);

  // Delete confirm state
  const [deleteState, setDeleteState] = useState<DeleteState | null>(null);

  // Active toggle optimistic update set (ids being toggled)
  const [togglingIds, setTogglingIds] = useState<Set<number>>(new Set());

  // ── Global ETL ─────────────────────────────────────────────────────────────

  async function handleRunAllEtl() {
    setEtlRunning(true);
    try {
      const result = await runEtl();
      toast.success(
        `ETL 완료 · ${formatInt(result.repos_upserted)} repos · ${formatInt(result.snapshots_inserted)} snapshots${result.repos_skipped ? ` · ${formatInt(result.repos_skipped)} 제외` : ''}`,
      );
      reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'ETL 실행에 실패했습니다.';
      toast.error(msg);
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
      toast.success(
        `ETL 완료 · ${formatInt(result.repos_upserted)} repos · ${formatInt(result.snapshots_inserted)} snapshots${result.repos_skipped ? ` · ${formatInt(result.repos_skipped)} 제외` : ''}`,
      );
      reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'ETL 실행에 실패했습니다.';
      toast.error(msg);
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
      toast.success(
        `'${row.query}' ${!row.is_active ? '활성화' : '비활성화'}됨.`,
      );
      reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '상태 변경에 실패했습니다.';
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
      toast.error('조건은 1–200자 사이로 입력하세요.');
      return;
    }
    setEditState((s) => s ? { ...s, saving: true } : s);
    try {
      await updateQuery(editState.id, { query: trimmed, query_type: editState.queryType });
      toast.success('조건이 수정되었습니다.');
      setEditState(null);
      reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '수정에 실패했습니다.';
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
      toast.success(`'${deleteState.query}' 조건이 삭제되었습니다.`);
      setDeleteState(null);
      reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '삭제에 실패했습니다.';
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
            aria-label="조건 수정"
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
            aria-label="타입 수정"
          >
            <option value="keyword">keyword</option>
            <option value="topic">topic</option>
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
        {row.query_type}
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
        title={row.is_active ? '클릭해 비활성화' : '클릭해 활성화'}
        aria-pressed={row.is_active}
      >
        {isToggling ? (
          <span className="spinner" style={{ width: 10, height: 10 }} />
        ) : (
          <span className={row.is_active ? 'dot' : 'dot dot--off'} />
        )}
        {row.is_active ? '활성' : '비활성'}
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
            저장
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={cancelEdit}
            disabled={isSaving}
          >
            취소
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
          수정
        </button>

        {/* Per-row ETL */}
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => handleRowEtl(row.id)}
          disabled={isRowEtlRunning || editState !== null || etlRunning || quotaExhausted}
          title={quotaExhausted ? quotaTooltip : '이 조건만 ETL 실행'}
          aria-label="ETL 실행"
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
          삭제
        </button>
      </div>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────

  return (
    <div className="page">
      {/* Header */}
      <div className={styles.headerRow}>
        <div className={`page__title ${styles.title}`}>QUERIES</div>
        <div className={styles.etlControls}>
          <Help
            text="지금 바로 수집을 실행해 최신 스타 수를 반영합니다. 활성 조건은 6시간마다 자동으로도 수집돼요. (수동 실행은 하루 한도가 있습니다)"
            label="수집(ETL) 설명"
          />
          {etl !== null && (
            <span
              className={quotaExhausted ? 'pill pill--accent' : 'pill'}
              title={quotaTooltip}
            >
              오늘 {etl.manual_used_today}/{etl.manual_limit}회
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
            전체 ETL 실행
          </button>
        </div>
      </div>

      {/* New query form */}
      <div className="stack">
        <QueryForm onCreated={reload} />

        {/* List panel */}
        <div className="panel panel--flush">
          {loading && <LoadingState />}

          {!loading && error && (
            <ErrorState message={error} onRetry={reload} />
          )}

          {!loading && !error && data !== null && data.length === 0 && (
            <EmptyState
              title="추적할 키워드를 등록해 보세요"
              hint={
                <>
                  관심 키워드를 등록하면 6시간마다 스타 증가율을 추적해 급상승 레포를 찾아줍니다.
                  <br />
                  1. 위에서 조건 추가 → 2. ‘실행(▶)’으로 즉시 수집 → 3. Repos·Dashboard에서 확인
                </>
              }
            />
          )}

          {!loading && !error && data !== null && data.length > 0 && (
            <div className={styles.tableWrap}>
              <table className="table table--rows">
                <thead>
                  <tr>
                    <th>Query</th>
                    <th>
                      Type{' '}
                      <Help text="keyword: 이름·설명·README에서 단어 검색 · topic: GitHub 토픽 태그로 검색" label="Type 설명" />
                    </th>
                    <th>상태</th>
                    <th className="col-num">Repos</th>
                    <th className="col-num">등록일</th>
                    <th>Actions</th>
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
                      <td className="col-num">
                        <span className="num">{formatInt(row.repo_count)}</span>
                      </td>
                      <td className="col-num">
                        <span className="num muted">
                          {formatDate(row.created_at)}
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
        title="조건 삭제"
        message={
          deleteState
            ? `'${deleteState.query}' 조건과 연관 레포·스냅샷이 모두 삭제됩니다.`
            : ''
        }
        confirmLabel="삭제"
        danger
        busy={deleteState?.busy ?? false}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
    </div>
  );
}
