// DashboardPage.tsx — 대시보드: 통계 카드 4개 + Top Movers 테이블 + 언어 분포 바
import { useAsync } from '../lib/useAsync';
import { getStats, getTrends, getRising, getLanguages } from '../api/stats';
import { formatCompactAge, formatInt } from '../lib/format';
import { LoadingState, ErrorState } from '../components/States';
import StatCard from '../components/StatCard';
import TrendTable from '../components/TrendTable';
import RisingTable from '../components/RisingTable';
import LanguageBars from '../components/LanguageBars';
import styles from './DashboardPage.module.css';

export default function DashboardPage() {
  const stats = useAsync(() => getStats(), []);
  const trends = useAsync(() => getTrends(10), []);
  const rising = useAsync(() => getRising(), []);
  const languages = useAsync(() => getLanguages(), []);

  return (
    <div className="page">
      <div className="page__title">DASHBOARD</div>

      {/* ── 통계 카드 4개 ──────────────────────────────────────────────── */}
      <div className="stagger grid-4" style={{ marginBottom: 'var(--gap)' }}>
        {stats.loading ? (
          <>
            <StatCard label="Repos" value="—" hint="추적 레포" />
            <StatCard label="Active Queries" value="—" hint="활성 조건" />
            <StatCard label="Bookmarked" value="—" hint="북마크" />
            <StatCard label="Last ETL" value="—" hint="마지막 수집" />
          </>
        ) : stats.error ? (
          <div style={{ gridColumn: '1 / -1' }}>
            <ErrorState message={stats.error} onRetry={stats.reload} />
          </div>
        ) : stats.data ? (
          <>
            <StatCard
              label="Repos"
              value={formatInt(stats.data.total_repos)}
              hint="추적 레포"
            />
            <StatCard
              label="Active Queries"
              value={formatInt(stats.data.active_queries)}
              hint="활성 조건"
            />
            <StatCard
              label="Bookmarked"
              value={formatInt(stats.data.bookmarked)}
              hint="북마크"
            />
            <StatCard
              label="Last ETL"
              value={stats.data.last_etl_at ? `${formatCompactAge(stats.data.last_etl_at)} 전` : '—'}
              hint={stats.data.last_etl_at ? '마지막 수집' : '아직 없음'}
            />
          </>
        ) : null}
      </div>

      {/* ── 두 컬럼: 성장률 상위 ‖ (신생 급상승 + 언어 분포) ─────────── */}
      <div className={styles.columns}>
        {/* 성장률 상위 */}
        <div className={styles.trendCol}>
          <div className="panel panel--flush">
            <div className="panel__head" style={{ padding: 'var(--pad) var(--pad) 0' }}>
              <span className="panel__title">성장률 상위</span>
              <span className={styles.titleEn}>TOP MOVERS</span>
            </div>
            <div className={styles.panelBody}>
              {trends.loading ? (
                <div style={{ padding: 'var(--pad)' }}>
                  <LoadingState />
                </div>
              ) : (
                <TrendTable
                  data={trends.data}
                  loading={trends.loading}
                  error={trends.error}
                  onRetry={trends.reload}
                />
              )}
            </div>
          </div>
        </div>

        {/* 오른쪽: 신생 급상승 + 언어 분포 */}
        <div className={styles.langCol}>
          <div className="panel panel--flush">
            <div className="panel__head" style={{ padding: 'var(--pad) var(--pad) 0' }}>
              <span className="panel__title">신생 급상승</span>
              <span className={styles.titleEn}>RISING</span>
            </div>
            <div className={styles.panelBody}>
              {rising.loading ? (
                <div style={{ padding: 'var(--pad)' }}>
                  <LoadingState />
                </div>
              ) : (
                <RisingTable
                  data={rising.data}
                  loading={rising.loading}
                  error={rising.error}
                  onRetry={rising.reload}
                />
              )}
            </div>
          </div>

          <div className="panel" style={{ marginTop: 'var(--gap)' }}>
            <div className="panel__head">
              <span className="panel__title">언어 분포</span>
              <span className={styles.titleEn}>LANGUAGES</span>
            </div>
            <div className={styles.panelBody}>
              <LanguageBars
                data={languages.data}
                loading={languages.loading}
                error={languages.error}
                onRetry={languages.reload}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
