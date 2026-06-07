// useAsync.ts — 데이터 패칭 3상태(loading/error/data)를 표준화하는 훅.
// 모든 페이지가 동일한 방식으로 로딩/에러/빈 상태를 처리하도록 한다.
import { useCallback, useEffect, useState } from 'react';

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export interface UseAsyncResult<T> extends AsyncState<T> {
  /** 동일 deps 로 다시 패칭 */
  reload: () => void;
  /** 낙관적 업데이트용 로컬 데이터 교체 */
  setData: (updater: T | ((prev: T | null) => T)) => void;
}

/**
 * @param fn   비동기 패처
 * @param deps fn 이 의존하는 값들 (바뀌면 자동 재패칭)
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): UseAsyncResult<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);

  // deps 로 패처를 메모이즈 (deps 가 바뀌면 effect 재실행)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const memoFn = useCallback(fn, deps);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    memoFn().then(
      (data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      },
      (err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.';
          setState({ data: null, loading: false, error: message });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [memoFn, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback(
    (updater: T | ((prev: T | null) => T)) =>
      setState((s) => ({
        ...s,
        data:
          typeof updater === 'function'
            ? (updater as (prev: T | null) => T)(s.data)
            : updater,
      })),
    [],
  );

  return { ...state, reload, setData };
}
