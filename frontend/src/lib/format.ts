// format.ts — 숫자/시간 포맷 헬퍼. 등폭 숫자(tabular-nums)와 함께 사용.

/** 1234 -> "1.2k", 134000 -> "134k", 2_500_000 -> "2.5M" */
export function formatStars(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  if (abs < 1_000_000) {
    const k = n / 1000;
    return `${trim(Math.abs(k) >= 100 ? Math.round(k) : round1(k))}k`;
  }
  const m = n / 1_000_000;
  return `${trim(round1(m))}M`;
}

/** +1200 -> "+1.2k", -96 -> "−96", 0 -> "0" */
export function formatDelta(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  if (n === 0) return '0';
  const sign = n > 0 ? '+' : '−';
  return `${sign}${formatStars(Math.abs(n))}`;
}

/** 0.009 -> "+0.9%", -0.12 -> "−12.0%" */
export function formatPercent(rate: number | null | undefined, digits = 1): string {
  if (rate == null || Number.isNaN(rate)) return '—';
  const pct = rate * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(digits)}%`;
}

/** 134000 -> "134,000" */
export function formatInt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

/** ISO -> "방금 전 / 12분 전 / 3시간 전 / 2일 전 / 2026. 6. 6." */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  if (diff < 0) return '방금 전';
  const sec = Math.round(diff / 1000);
  if (sec < 60) return '방금 전';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}일 전`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month}개월 전`;
  return new Date(iso).toLocaleDateString('ko-KR');
}

/** ISO -> 컴팩트 경과시간 "15 min" / "3 hr" / "2 d" (스탯 타일용) */
export function formatCompactAge(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  if (diff < 0) return '방금';
  const sec = Math.round(diff / 1000);
  if (sec < 60) return '방금';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr`;
  const day = Math.round(hr / 24);
  return `${day} d`;
}

/** ISO -> "2026. 07. 14." (날짜만) */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** ISO -> "2026. 6. 6. 오후 3:00" */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function trim(n: number): string {
  return String(n).replace(/\.0$/, '');
}
