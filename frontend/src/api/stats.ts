// stats.ts — 대시보드 통계/트렌드/언어분포 + ETL 호출.
import { api } from './client';
import type {
  Stats,
  TrendRepo,
  LanguageStat,
  EtlRunResult,
  EtlStatus,
} from '../types';

export const getStats = () => api.get<Stats>('/stats');

export const getTrends = (limit = 10) => api.get<TrendRepo[]>('/trends', { limit });

export const getLanguages = () => api.get<LanguageStat[]>('/stats/languages');

/** ETL 실행. queryId 가 있으면 해당 조건만, 없으면 전체 활성 조건. */
export const runEtl = (queryId?: number) =>
  api.post<EtlRunResult>('/etl/run', undefined, queryId ? { query_id: queryId } : undefined);

export const getEtlStatus = () => api.get<EtlStatus>('/etl/status');
