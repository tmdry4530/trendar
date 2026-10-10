// TrendTable.tsx — 상승 레포 테이블 (ranking score 기준 상위 N)
import { useNavigate, Link } from 'react-router-dom';
import type { TrendRepo } from '../types';
import { formatStars, formatDelta, formatPercent } from '../lib/format';
import { LoadingState, ErrorState, EmptyState } from './States';
import styles from './TrendTable.module.css';
import { useTranslation } from 'react-i18next';
import { toSupportedLocale } from '../i18n';

interface TrendTableProps {
  data: TrendRepo[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** 좁은 컬럼에서 Lang 열을 숨겨 잘림 방지 */
  compact?: boolean;
}

export default function TrendTable({ data, loading, error, onRetry, compact = false }: TrendTableProps) {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const locale = toSupportedLocale(i18n.resolvedLanguage) ?? 'en';

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!data || data.length === 0) {
    return (
      <EmptyState
        title={t('dashboard.empty.title')}
        hint={t('dashboard.empty.hint')}
        action={
          <Link className="btn btn--sm btn--primary" to="/queries">
            {t('dashboard.empty.action')}
          </Link>
        }
      />
    );
  }

  return (
    <table className="table table--rows table--dense">
      <thead>
        <tr>
          <th>{t('dashboard.table.project')}</th>
          {!compact && <th>{t('dashboard.table.language')}</th>}
          <th className="col-num">{t('dashboard.table.stars')}</th>
          <th className="col-num">{t('dashboard.table.increase24h')}</th>
          <th className="col-num">{t('dashboard.table.growth')}</th>
        </tr>
      </thead>
      <tbody>
        {data.map((repo) => {
          const deltaClass =
            repo.delta_24h > 0
              ? 'delta delta--up'
              : repo.delta_24h < 0
                ? 'delta delta--down'
                : 'delta delta--flat';

          return (
            <tr key={repo.id} onClick={() => navigate(`/repos/${repo.id}`)}>
              <td>
                <div className={`${styles.repoCell} truncate`}>{repo.full_name}</div>
              </td>
              {!compact && (
                <td>
                  {repo.language ? (
                    <span className="tag">{repo.language}</span>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
              )}
              <td className="col-num">
                <span className="stars">★ {formatStars(repo.stars, locale)}</span>
              </td>
              <td className="col-num">
                <span className={deltaClass}>{formatDelta(repo.delta_24h, locale)}</span>
              </td>
              <td className="col-num">
                <span className={styles.growthRate}>{formatPercent(repo.growth_rate, 1, locale)}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
