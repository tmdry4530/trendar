// LanguageBars.tsx — 언어별 레포 수 수평 바 차트
import type { LanguageStat } from '../types';
import { LoadingState, ErrorState, EmptyState } from './States';
import styles from './LanguageBars.module.css';

interface LanguageBarsProps {
  data: LanguageStat[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export default function LanguageBars({ data, loading, error, onRetry }: LanguageBarsProps) {
  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!data || data.length === 0) {
    return <EmptyState title="언어 데이터 없음" />;
  }

  const maxCount = Math.max(...data.map((d) => d.count), 1);

  return (
    <div className={styles.list}>
      {data.map((item, idx) => {
        const label = item.language ?? 'Unknown';
        const widthPct = (item.count / maxCount) * 100;
        return (
          <div key={`${label}-${idx}`} className={styles.row}>
            <div className={styles.labelRow}>
              <span className={styles.langName}>{label}</span>
              <span className={styles.count}>{item.count}</span>
            </div>
            <div className={styles.track}>
              <div className={styles.fill} style={{ width: `${widthPct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
