// QueryForm.tsx — 새 검색 조건 추가 폼 (+ 새 조건 추가 패널).
import { useState } from 'react';
import { createQuery } from '../api/queries';
import { ApiError } from '../api/client';
import { useToast } from './Toast';
import type { QueryType } from '../types';
import styles from './QueryForm.module.css';
import { useTranslation } from 'react-i18next';

interface Props {
  onCreated: () => void;
  /** QUERY_LIMIT_EXCEEDED 시 호출 (업그레이드 안내용) */
  onLimitExceeded?: () => void;
}

export default function QueryForm({ onCreated, onLimitExceeded }: Props) {
  const toast = useToast();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [queryType, setQueryType] = useState<QueryType>('keyword');
  const [submitting, setSubmitting] = useState(false);

  const trimmed = query.trim();
  const isValid = trimmed.length >= 1 && trimmed.length <= 200;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) {
      toast.error(t('queries.validation'));
      return;
    }
    setSubmitting(true);
    try {
      await createQuery({ query: trimmed, query_type: queryType });
      toast.success(t('queries.added', { name: trimmed }));
      setQuery('');
      setQueryType('keyword');
      onCreated();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('errors.generic');
      toast.error(msg);
      if (err instanceof ApiError && err.code === 'QUERY_LIMIT_EXCEEDED') onLimitExceeded?.();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">+ {t('queries.addTitle')}</span>
      </div>
      <form onSubmit={handleSubmit}>
        <div className={styles.formRow}>
          <input
            className={`input ${styles.queryInput}`}
            type="text"
            placeholder={t('queries.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={submitting}
            maxLength={200}
            aria-label={t('queries.inputLabel')}
          />
          <select
            className={`select ${styles.typeSelect}`}
            value={queryType}
            onChange={(e) => setQueryType(e.target.value as QueryType)}
            disabled={submitting}
            aria-label={t('queries.typeLabel')}
          >
            <option value="keyword">{t('queries.keyword')}</option>
            <option value="topic">{t('queries.topic')}</option>
          </select>
          <button
            type="submit"
            className={`btn btn--primary ${styles.submitBtn}`}
            disabled={submitting || !isValid}
          >
            {submitting ? <span className="spinner" /> : null}
            {t('queries.add')}
          </button>
        </div>
      </form>
    </div>
  );
}
