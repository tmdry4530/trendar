// StatCard.tsx — 대시보드 단일 통계 카드 (레이블 + 큰 값 + 힌트, 선택적 링크·스켈레톤 지원)
import { Link } from 'react-router-dom';
import styles from './StatCard.module.css';

interface StatCardProps {
  label: string;
  value: string | number;
  hint?: string;
  accent?: boolean;
  to?: string;
  loading?: boolean;
}

export default function StatCard({ label, value, hint, accent = false, to, loading = false }: StatCardProps) {
  const cls = `${styles.card}${accent ? ` ${styles['card--accent']}` : ''}${to ? ` ${styles.interactive}` : ''}`;
  const content = (
    <>
      <div className={styles.head}>
        <div className={styles.label}>{label}</div>
        {to && <span className={styles.arrow} aria-hidden>↗</span>}
      </div>
      {loading ? (
        <span className={`skeleton ${styles.valueSkeleton}`} aria-hidden />
      ) : (
        <div className={styles.value}>{value}</div>
      )}
      {hint && <div className={styles.hint}>{hint}</div>}
    </>
  );

  if (to) {
    return (
      <Link to={to} className={cls}>
        {content}
      </Link>
    );
  }

  return <div className={cls}>{content}</div>;
}
