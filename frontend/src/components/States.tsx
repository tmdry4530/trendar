// States.tsx — 로딩 / 빈 / 에러 3종 공통 상태 컴포넌트. 모든 페이지가 동일 톤으로 사용.
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './States.module.css';

export function LoadingState({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <div className={styles.state}>
      <span className="spinner" />
      <span className={styles.dim}>{label ?? t('common.loadingData')}</span>
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
  icon = '∅',
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className={styles.state}>
      <div className={styles.icon} aria-hidden>
        {icon}
      </div>
      <div className={styles.title}>{title}</div>
      {hint && <div className={styles.dim}>{hint}</div>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={`${styles.state} ${styles.errorWrap}`}>
      <div className={`${styles.icon} ${styles.errorIcon}`} aria-hidden>
        ⚠
      </div>
      <div className={styles.title}>{t('common.requestFailed')}</div>
      <div className={styles.dim}>{message}</div>
      {onRetry && (
        <button type="button" className="btn btn--sm" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

/** 인라인(작은) 로딩 표시 */
export function InlineSpinner({ label }: { label?: string }) {
  return (
    <span className={styles.inline}>
      <span className="spinner" />
      {label && <span className={styles.dim}>{label}</span>}
    </span>
  );
}

/** 테이블 로딩 스켈레톤 — 레이아웃 점프 방지 */
export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  const { t } = useTranslation();
  return (
    <div className={styles.skeletonWrap} role="status" aria-label={t('common.loadingData')}>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className={styles.skeletonRow}>
          {Array.from({ length: columns }).map((__, c) => (
            <span
              key={c}
              className={`skeleton ${styles.skeletonCell} ${c === 0 ? styles.skeletonPrimary : ''}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
