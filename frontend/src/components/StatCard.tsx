// StatCard.tsx — 대시보드 단일 통계 카드 (레이블 + 큰 값 + 힌트)
import styles from './StatCard.module.css';

interface StatCardProps {
  label: string;
  value: string | number;
  hint?: string;
  accent?: boolean;
}

export default function StatCard({ label, value, hint, accent = false }: StatCardProps) {
  return (
    <div className={`${styles.card}${accent ? ` ${styles['card--accent']}` : ''}`}>
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>{value}</div>
      {hint && <div className={styles.hint}>{hint}</div>}
    </div>
  );
}
