// RisingTable.tsx — 신생 급상승 레포 (rising-score-v3 점수 순, 최근 생성 레포)
import { useNavigate } from 'react-router-dom';
import type { RisingRepo } from '../types';
import { formatStars, formatDelta, formatPercent, formatRelativeTime } from '../lib/format';
import { LoadingState, ErrorState } from './States';
import styles from './RisingTable.module.css';
import { useTranslation } from 'react-i18next';
import { toSupportedLocale } from '../i18n';

// 이전 하루 대비 가속도 표시 임계값
const ACCEL_UP = 1.2;
const ACCEL_DOWN = 0.8;

interface RisingTableProps {
  data: RisingRepo[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export default function RisingTable({ data, loading, error, onRetry }: RisingTableProps) {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const locale = toSupportedLocale(i18n.resolvedLanguage) ?? 'en';

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!data || data.length === 0) {
    return <div className={styles.empty}>{t('dashboard.rising.empty')}</div>;
  }

  return (
    <table className={`table table--rows table--dense ${styles.table}`}>
      <thead>
        <tr>
          <th>{t('dashboard.table.project')}</th>
          <th>{t('dashboard.table.language')}</th>
          <th className="col-num">{t('dashboard.table.stars')}</th>
          <th className="col-num">{t('dashboard.table.increase24h')}</th>
          <th className="col-num">{t('dashboard.table.age')}</th>
        </tr>
      </thead>
      <tbody>
        {data.map((repo) => {
          // 기준선 구간은 수집 타이밍에 따라 20~36시간(partial은 더 짧게)으로 달라지므로,
          // 항상 하루 환산값(rate_24h)을 보여 준다. 구형 응답(rate_24h 없음)은 star_delta_24h 그대로.
          const shownDelta = repo.rate_24h != null ? Math.round(repo.rate_24h) : repo.star_delta_24h;
          const spanHours = repo.span_hours != null ? Math.round(repo.span_hours) : null;
          const deltaClass =
            shownDelta > 0 ? 'delta delta--up'
            : shownDelta < 0 ? 'delta delta--down'
            : 'delta delta--flat';
          const estimated = repo.baseline_source != null && repo.baseline_source !== 'snapshot';
          const trend =
            repo.accel == null ? null
            : repo.accel >= ACCEL_UP ? 'up'
            : repo.accel <= ACCEL_DOWN ? 'down'
            : null;
          return (
            <tr
              key={repo.id}
              onClick={() => navigate(`/repos/${repo.id}`)}
              title={spanHours != null && spanHours !== 24
                ? t('dashboard.rising.detailSpan', {
                    hours: spanHours,
                    delta: formatDelta(repo.star_delta_24h, locale),
                    rate: formatPercent(repo.growth_rate_24h, 1, locale),
                  })
                : t('dashboard.rising.detail', {
                    delta: formatDelta(repo.star_delta_24h, locale),
                    rate: formatPercent(repo.growth_rate_24h, 1, locale),
                  })}
            >
              <td>
                <div className={`${styles.repoCell} truncate`} title={repo.full_name}>{repo.full_name}</div>
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
                {trend && (
                  <span
                    className={trend === 'up' ? styles.accelUp : styles.accelDown}
                    title={t(trend === 'up' ? 'dashboard.rising.accelerating' : 'dashboard.rising.slowing')}
                    aria-label={t(trend === 'up' ? 'dashboard.rising.accelerating' : 'dashboard.rising.slowing')}
                  >
                    {trend === 'up' ? '↑' : '↓'}
                  </span>
                )}
                <span className={deltaClass}>{formatDelta(shownDelta, locale)}</span>
                {estimated && (
                  <span className={styles.est} title={t('dashboard.rising.estimatedHint')}>
                    {t('dashboard.rising.estimated')}
                  </span>
                )}
              </td>
              <td className="col-num">
                <span className={styles.age}>{formatRelativeTime(repo.github_created_at, locale)}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
