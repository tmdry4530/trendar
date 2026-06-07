// repos.ts — 레포 목록/상세/수정/삭제 호출.
import { api } from './client';
import type {
  Repo,
  RepoListResult,
  RepoDetailResult,
  Snapshot,
  RepoQueryParams,
  UpdateRepoInput,
  DeletedResult,
} from '../types';

export const listRepos = (params: RepoQueryParams = {}) =>
  api.get<RepoListResult>('/repos', params as Record<string, string | number | boolean | undefined>);

export const getRepo = (id: number) => api.get<RepoDetailResult>(`/repos/${id}`);

export const getRepoSnapshots = (id: number) =>
  api.get<Snapshot[]>(`/repos/${id}/snapshots`);

export const updateRepo = (id: number, input: UpdateRepoInput) =>
  api.patch<Repo>(`/repos/${id}`, input);

export const deleteRepo = (id: number) =>
  api.delete<DeletedResult>(`/repos/${id}`);
