// RisingTable.tsx — 신생 급상승 레포 테이블 (velocity 기준 정렬, 최근 생성 레포)
import { useNavigate } from 'react-router-dom';
import type { RisingRepo } from '../types';
import { formatStars, formatRelativeTime } from '../lib/format';
import { LoadingState, ErrorState } from './States';
import styles from './RisingTable.module.css';

interface RisingTableProps {
  data: RisingRepo[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export default function RisingTable({ data, loading, error, onRetry }: RisingTableProps) {
  const navigate = useNavigate();

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!data || data.length === 0) {
    return <div className={styles.empty}>아직 신생 레포가 없습니다 · 수집을 실행해 보세요</div>;
  }

  return (
    <table className="table table--rows">
      <thead>
        <tr>
          <th>Repo</th>
          <th className="col-num">Stars</th>
          <th className="col-num">Age</th>
        </tr>
      </thead>
      <tbody>
        {data.map((repo) => (
          <tr
            key={repo.id}
            onClick={() => navigate(`/repos/${repo.id}`)}
            title={`${repo.language ?? ''} · velocity ${repo.velocity}`.trim()}
          >
            <td>
              <div className={`${styles.repoCell} truncate`}>{repo.full_name}</div>
            </td>
            <td className="col-num">
              <span className="stars">★ {formatStars(repo.stars)}</span>
            </td>
            <td className="col-num">
              <span className={styles.age}>{formatRelativeTime(repo.github_created_at)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
