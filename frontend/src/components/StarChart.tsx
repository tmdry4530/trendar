// StarChart.tsx — recharts 기반 스타 추이 라인차트.
// 주의: recharts SVG props (stroke/fill/tick) 에는 리터럴 hex 사용 필요.
// 아래 값들은 tokens.css 변수를 그대로 미러링:
//   accent   = #3ddc84  (--accent / --up)
//   grid     = #232830  (--line)
//   ticks    = #8b93a1  (--muted)
//   surface  = #14171c  (--surface)
import {
  ResponsiveContainer,
  LineChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Line,
  Tooltip,
} from 'recharts';
import type { TooltipProps } from 'recharts';
import type { Snapshot } from '../types';
import { formatStars, formatDateTime } from '../lib/format';
import styles from './StarChart.module.css';

interface Props {
  snapshots: Snapshot[];
}

// recharts TooltipProps — 값 타입은 number | string | (number | string)[]
type CustomTooltipProps = TooltipProps<number, string>;

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  const snap = payload[0]?.payload as Snapshot;
  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipDate}>{formatDateTime(snap.captured_at)}</div>
      <div className={styles.tooltipRow}>
        <span className={styles.tooltipStar}>★</span>
        <span className={styles.tooltipVal}>{formatStars(snap.stars)}</span>
      </div>
      {snap.forks != null && (
        <div className={styles.tooltipRow}>
          <span className={styles.tooltipMuted}>⑂</span>
          <span className={styles.tooltipMuted}>{snap.forks.toLocaleString('en-US')}</span>
        </div>
      )}
      {snap.open_issues != null && (
        <div className={styles.tooltipRow}>
          <span className={styles.tooltipMuted}>◔</span>
          <span className={styles.tooltipMuted}>{snap.open_issues.toLocaleString('en-US')} issues</span>
        </div>
      )}
    </div>
  );
}

export default function StarChart({ snapshots }: Props) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={snapshots} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        {/* stroke colors mirror tokens.css — recharts can't read CSS vars */}
        <CartesianGrid stroke="#232830" strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="captured_at"
          tickFormatter={(v: string) =>
            new Date(v).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
          }
          tick={{ fill: '#8b93a1', fontSize: 11, fontFamily: 'IBM Plex Mono, ui-monospace, monospace' }}
          axisLine={{ stroke: '#232830' }}
          tickLine={{ stroke: '#232830' }}
        />
        <YAxis
          tickFormatter={(v: number) => formatStars(v)}
          tick={{ fill: '#8b93a1', fontSize: 11, fontFamily: 'IBM Plex Mono, ui-monospace, monospace' }}
          width={48}
          axisLine={{ stroke: '#232830' }}
          tickLine={{ stroke: '#232830' }}
          domain={['auto', 'auto']}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#232830', strokeWidth: 1 }} />
        <Line
          type="monotone"
          dataKey="stars"
          stroke="#3ddc84"
          strokeWidth={2}
          dot={{ r: 2, fill: '#3ddc84', strokeWidth: 0 }}
          activeDot={{ r: 4, fill: '#3ddc84', strokeWidth: 0 }}
          isAnimationActive
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
