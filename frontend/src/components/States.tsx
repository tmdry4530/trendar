// States.tsx — 로딩 / 빈 / 에러 3종 공통 상태 컴포넌트. 모든 페이지가 동일 톤으로 사용.
import type { ReactNode } from 'react';
import styles from './States.module.css';

export function LoadingState({ label = '데이터 불러오는 중…' }: { label?: string }) {
  return (
    <div className={styles.state}>
      <span className="spinner" />
      <span className={styles.dim}>{label}</span>
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
  hint?: string;
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
  return (
    <div className={`${styles.state} ${styles.errorWrap}`}>
      <div className={`${styles.icon} ${styles.errorIcon}`} aria-hidden>
        ⚠
      </div>
      <div className={styles.title}>요청을 처리하지 못했습니다</div>
      <div className={styles.dim}>{message}</div>
      {onRetry && (
        <button type="button" className="btn btn--sm" onClick={onRetry}>
          다시 시도
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
