// utils/kst.js — KST(UTC+9) 기준 날짜 계산. 서버 타임존과 무관하게 동작한다.
// now 파라미터는 테스트 주입용.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** KST 기준 오늘 날짜 문자열 ('YYYY-MM-DD') */
export function kstToday(now = new Date()) {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 다음 KST 자정의 UTC 시각 (= 한도 리셋 시각) */
export function kstNextMidnight(now = new Date()) {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  const nextKstDayAsUtcMs = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + 1
  );
  return new Date(nextKstDayAsUtcMs - KST_OFFSET_MS);
}
