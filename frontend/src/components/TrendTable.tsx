// TrendTable.tsx — 상승 레포 테이블 (star delta 기준 상위 N)
import { useNavigate, Link } from 'react-router-dom';
import type { TrendRepo } from '../types';
import { formatStars, formatDelta, formatPercent } from '../lib/format';
import { LoadingState, ErrorState, EmptyState } from './States';
import styles from './TrendTable.module.css';

interface TrendTableProps {
  data: TrendRepo[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export default function TrendTable({ data, loading, error, onRetry }: TrendTableProps) {
  const navigate = useNavigate();

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!data || data.length === 0) {
    return (
      <EmptyState
        title="수집된 레포가 없습니다"
        hint="Queries에서 조건을 추가하고 ETL을 실행하세요"
        action={
          <Link className="btn btn--sm btn--primary" to="/queries">
            조건 관리로
          </Link>
        }
      />
    );
  }

  return (
    <table className="table table--rows">
      <thead>
        <tr>
          <th>Repo</th>
          <th>Lang</th>
          <th className="col-num">Stars</th>
          <th className="col-num">Δ</th>
        </tr>
      </thead>
      <tbody>
        {data.map((repo) => {
          const deltaClass =
            repo.star_delta > 0
              ? 'delta delta--up'
              : repo.star_delta < 0
                ? 'delta delta--down'
                : 'delta delta--flat';

          return (
            <tr key={repo.id} onClick={() => navigate(`/repos/${repo.id}`)}>
              <td>
                <div className={`${styles.repoCell} truncate`}>{repo.full_name}</div>
              </td>
              <td>
                {repo.language ? (
                  <span className="tag">{repo.language}</span>
                ) : (
                  <span className="faint">—</span>
                )}
              </td>
              <td className="col-num">
                <span className="stars">★ {formatStars(repo.stars)}</span>
              </td>
              <td className="col-num">
                <div className={styles.deltaWrap}>
                  <span className={deltaClass}>{formatDelta(repo.star_delta)}</span>
                  <span className={styles.growthRate}>{formatPercent(repo.growth_rate)}</span>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
