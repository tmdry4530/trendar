// QueryForm.tsx — 새 검색 조건 추가 폼 (+ 새 조건 추가 패널).
import { useState } from 'react';
import { createQuery } from '../api/queries';
import { useToast } from './Toast';
import type { QueryType } from '../types';
import styles from './QueryForm.module.css';

interface Props {
  onCreated: () => void;
}

export default function QueryForm({ onCreated }: Props) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [queryType, setQueryType] = useState<QueryType>('keyword');
  const [submitting, setSubmitting] = useState(false);

  const trimmed = query.trim();
  const isValid = trimmed.length >= 1 && trimmed.length <= 200;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) {
      toast.error('조건은 1–200자 사이로 입력하세요.');
      return;
    }
    setSubmitting(true);
    try {
      await createQuery({ query: trimmed, query_type: queryType });
      toast.success(`'${trimmed}' 조건이 추가되었습니다.`);
      setQuery('');
      setQueryType('keyword');
      onCreated();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '조건 추가에 실패했습니다.';
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">+ 새 조건 추가</span>
      </div>
      <form onSubmit={handleSubmit}>
        <div className={styles.formRow}>
          <input
            className={`input ${styles.queryInput}`}
            type="text"
            placeholder="예: hermes agent"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={submitting}
            maxLength={200}
            aria-label="검색 조건"
          />
          <select
            className={`select ${styles.typeSelect}`}
            value={queryType}
            onChange={(e) => setQueryType(e.target.value as QueryType)}
            disabled={submitting}
            aria-label="조건 타입"
          >
            <option value="keyword">keyword</option>
            <option value="topic">topic</option>
          </select>
          <button
            type="submit"
            className={`btn btn--primary ${styles.submitBtn}`}
            disabled={submitting || !isValid}
          >
            {submitting ? <span className="spinner" /> : null}
            추가
          </button>
        </div>
      </form>
    </div>
  );
}
