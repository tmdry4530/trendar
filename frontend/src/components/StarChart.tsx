// StarChart.tsx — recharts 기반 스타 추이 라인차트.
// 주의: recharts SVG props (stroke/fill/tick) 에는 리터럴 hex 사용 필요.
// 아래 값들은 tokens.css 변수를 그대로 미러링:
//   accent   = #3ddc84  (--accent / --up)
//   grid     = #232830  (--line)
//   ticks    = #8b93a1  (--muted)
//   surface  = #14171c  (--surface)
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
} from 'recharts';
import type { TooltipProps } from 'recharts';
import type { Snapshot } from '../types';
import { formatStars, formatDateTime } from '../lib/format';
import styles from './StarChart.module.css';
import { useTranslation } from 'react-i18next';
import { toSupportedLocale } from '../i18n';

interface Props {
  snapshots: Snapshot[];
}

// recharts TooltipProps — 값 타입은 number | string | (number | string)[]
type CustomTooltipProps = TooltipProps<number, string>;

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  const { t, i18n } = useTranslation();
  const locale = toSupportedLocale(i18n.resolvedLanguage) ?? 'en';
  if (!active || !payload?.length) return null;
  const snap = payload[0]?.payload as Snapshot;
  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipDate}>{formatDateTime(snap.captured_at, locale)}</div>
      <div className={styles.tooltipRow}>
        <span className={styles.tooltipStar}>★</span>
        <span className={styles.tooltipVal}>{formatStars(snap.stars, locale)}</span>
      </div>
      {snap.forks != null && (
        <div className={styles.tooltipRow}>
          <span className={styles.tooltipMuted}>⑂</span>
          <span className={styles.tooltipMuted}>{snap.forks.toLocaleString(locale)}</span>
        </div>
      )}
      {snap.open_issues != null && (
        <div className={styles.tooltipRow}>
          <span className={styles.tooltipMuted}>◔</span>
          <span className={styles.tooltipMuted}>{t('detail.chartIssues', { count: snap.open_issues.toLocaleString(locale) })}</span>
        </div>
      )}
    </div>
  );
}

export default function StarChart({ snapshots }: Props) {
  const { i18n } = useTranslation();
  const locale = toSupportedLocale(i18n.resolvedLanguage) ?? 'en';
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={snapshots} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="starAreaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3ddc84" stopOpacity={0.26} />
            <stop offset="100%" stopColor="#3ddc84" stopOpacity={0} />
          </linearGradient>
        </defs>
        {/* stroke colors mirror tokens.css — recharts can't read CSS vars */}
        <CartesianGrid stroke="#232830" strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="captured_at"
          tickFormatter={(v: string) => {
            const d = new Date(v);
            return `${d.getMonth() + 1}/${d.getDate()}`;
          }}
          interval="preserveStartEnd"
          minTickGap={36}
          tick={{ fill: '#8b93a1', fontSize: 11, fontFamily: 'IBM Plex Mono, ui-monospace, monospace' }}
          axisLine={{ stroke: '#232830' }}
          tickLine={{ stroke: '#232830' }}
        />
        <YAxis
          tickFormatter={(v: number) => formatStars(v, locale)}
          tick={{ fill: '#8b93a1', fontSize: 11, fontFamily: 'IBM Plex Mono, ui-monospace, monospace' }}
          width={52}
          axisLine={{ stroke: '#232830' }}
          tickLine={{ stroke: '#232830' }}
          domain={['auto', 'auto']}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#2aa563', strokeDasharray: '3 3', strokeWidth: 1 }} />
        <Area
          type="monotone"
          dataKey="stars"
          stroke="#3ddc84"
          strokeWidth={2}
          fill="url(#starAreaFill)"
          dot={snapshots.length <= 24 ? { r: 2.5, fill: '#3ddc84', strokeWidth: 0 } : false}
          activeDot={{ r: 5, fill: '#3ddc84', stroke: '#14171c', strokeWidth: 2 }}
          isAnimationActive
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
