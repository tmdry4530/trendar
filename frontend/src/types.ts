// types.ts — docs/API.md 계약 기반 타입 정의 (진실의 원천).
// 백엔드 응답의 { ok, data } 봉투는 client.ts 가 벗겨내므로, 여기서는 data 페이로드만 정의한다.

export type QueryType = 'topic' | 'keyword';

/** GET /api/queries 항목 */
export interface WatchQuery {
  id: number;
  query: string;
  query_type: QueryType;
  is_active: boolean;
  repo_count: number;
  created_at: string;
}

/** POST /api/queries body */
export interface CreateQueryInput {
  query: string;
  query_type?: QueryType;
}

/** PATCH /api/queries/:id body (부분 수정) */
export interface UpdateQueryInput {
  query?: string;
  query_type?: QueryType;
  is_active?: boolean;
}

/** repos 항목 (목록/상세 공용). note 는 상세에서만 채워질 수 있어 optional. */
export interface Repo {
  id: number;
  github_id: number;
  query_id: number;
  full_name: string;
  owner: string;
  name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  stars: number;
  star_delta: number;
  growth_rate: number;
  is_bookmarked: boolean;
  note?: string | null;
  first_seen_at?: string;
  updated_at?: string;
}

/** repo_snapshots 시계열 1점 */
export interface Snapshot {
  captured_at: string;
  stars: number;
  forks: number;
  open_issues: number;
  watchers?: number;
}

/** GET /api/repos 응답 */
export interface RepoListResult {
  items: Repo[];
  total: number;
}

/** GET /api/repos/:id 응답 */
export interface RepoDetailResult {
  repo: Repo;
  snapshots: Snapshot[];
}

export type RepoSort = 'stars' | 'growth' | 'recent';

/** GET /api/repos 쿼리 파라미터 */
export interface RepoQueryParams {
  query_id?: number;
  bookmarked?: boolean;
  search?: string;
  sort?: RepoSort;
  limit?: number;
  offset?: number;
}

/** PATCH /api/repos/:id body */
export interface UpdateRepoInput {
  note?: string;
  is_bookmarked?: boolean;
}

/** GET /api/stats */
export interface Stats {
  total_repos: number;
  active_queries: number;
  bookmarked: number;
  last_etl_at: string | null;
}

/** GET /api/trends 항목 */
export interface TrendRepo {
  id: number;
  full_name: string;
  stars: number;
  star_delta: number;
  growth_rate: number;
  language: string | null;
}

/** GET /api/stats/languages 항목 */
export interface LanguageStat {
  language: string | null;
  count: number;
}

/** POST /api/etl/run 응답 */
export interface EtlRunResult {
  queries_processed: number;
  repos_upserted: number;
  snapshots_inserted: number;
  repos_skipped: number;
  errors: string[];
}

/** GET /api/etl/status 응답 */
export interface EtlStatus {
  last_etl_at: string | null;
  last_etl_status: 'ok' | 'error' | 'token_invalid' | null;
  last_etl_message: string | null;
  running: boolean;
  cron: string;
}

/** DELETE 공통 응답 */
export interface DeletedResult {
  deleted: boolean;
}

/** GET /api/auth/me 응답의 user */
export interface AuthUser {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/** GET /api/auth/me 응답 */
export interface Me {
  user: AuthUser;
  tokenInvalid: boolean;
}
