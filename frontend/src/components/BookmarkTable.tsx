// BookmarkTable.tsx — 관심 레포(북마크) 테이블
import { useNavigate } from 'react-router-dom';
import type { BookmarkRepo } from '../types';
import { formatStars, formatDelta } from '../lib/format';
import { LoadingState, ErrorState } from './States';
import styles from './BookmarkTable.module.css';
import { useTranslation } from 'react-i18next';
import { toSupportedLocale } from '../i18n';

interface BookmarkTableProps {
  data: BookmarkRepo[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export default function BookmarkTable({ data, loading, error, onRetry }: BookmarkTableProps) {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const locale = toSupportedLocale(i18n.resolvedLanguage) ?? 'en';

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!data || data.length === 0) {
    return <div className={styles.empty}>{t('dashboard.saved.empty')}</div>;
  }

  return (
    <table className="table table--rows table--dense">
      <thead>
        <tr>
          <th>{t('dashboard.table.project')}</th>
          <th>{t('dashboard.table.language')}</th>
          <th className="col-num">{t('dashboard.table.stars')}</th>
          <th className="col-num">{t('dashboard.table.increase')}</th>
        </tr>
      </thead>
      <tbody>
        {data.map((repo) => {
          const deltaClass =
            repo.star_delta > 0 ? 'delta delta--up'
            : repo.star_delta < 0 ? 'delta delta--down'
            : 'delta delta--flat';
          return (
            <tr
              key={repo.id}
              tabIndex={0}
              onClick={() => navigate(`/repos/${repo.id}`)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  navigate(`/repos/${repo.id}`);
                }
              }}
            >
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
                <span className="stars">★ {formatStars(repo.stars, locale)}</span>
              </td>
              <td className="col-num">
                <span className={deltaClass}>{formatDelta(repo.star_delta, locale)}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
